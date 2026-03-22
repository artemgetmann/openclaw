import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayChannelConnectTests {
    private actor AuthCapture {
        struct Snapshot: Sendable {
            var token: String?
            var deviceToken: String?
        }

        private var snapshot = Snapshot()

        func store(token: String?, deviceToken: String?) {
            self.snapshot = Snapshot(token: token, deviceToken: deviceToken)
        }

        func load() -> Snapshot {
            self.snapshot
        }
    }

    private enum FakeResponse {
        case helloOk(delayMs: Int)
        case invalid(delayMs: Int)
        case authFailed(
            delayMs: Int,
            detailCode: String,
            canRetryWithDeviceToken: Bool,
            recommendedNextStep: String?)
    }

    private func makeSession(response: FakeResponse) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let delayMs: Int
                        let message: URLSessionWebSocketTask.Message
                        switch response {
                        case let .helloOk(ms):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                        case let .invalid(ms):
                            delayMs = ms
                            message = .string("not json")
                        case let .authFailed(ms, detailCode, canRetryWithDeviceToken, recommendedNextStep):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                                id: id,
                                detailCode: detailCode,
                                canRetryWithDeviceToken: canRetryWithDeviceToken,
                                recommendedNextStep: recommendedNextStep))
                        }
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        return message
                    })
            })
    }

    @Test func `concurrent connect is single flight on success`() async throws {
        let session = self.makeSession(response: .helloOk(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        _ = try await t1.value
        _ = try await t2.value

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `concurrent connect shares failure`() async throws {
        let session = self.makeSession(response: .invalid(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        let r1 = await t1.result
        let r2 = await t2.result

        #expect({
            if case .failure = r1 { true } else { false }
        }())
        #expect({
            if case .failure = r2 { true } else { false }
        }())
        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `connect surfaces structured auth failure`() async throws {
        let session = self.makeSession(response: .authFailed(
            delayMs: 0,
            detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue,
            canRetryWithDeviceToken: true,
            recommendedNextStep: GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            try await channel.connect()
            Issue.record("expected GatewayConnectAuthError")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .authTokenMissing)
            #expect(error.detailCode == GatewayConnectAuthDetailCode.authTokenMissing.rawValue)
            #expect(error.canRetryWithDeviceToken)
            #expect(error.recommendedNextStep == .updateAuthConfiguration)
            #expect(error.recommendedNextStepCode == GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @MainActor
    @Test func `trusted localhost connect attaches paired device token on first attempt`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-gateway-channel-\(UUID().uuidString)", isDirectory: true)

        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "device-token")

            let capture = AuthCapture()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { _, message, sendIndex in
                            guard sendIndex == 0 else { return }
                            let data: Data?
                            switch message {
                            case let .data(raw):
                                data = raw
                            case let .string(raw):
                                data = raw.data(using: .utf8)
                            @unknown default:
                                data = nil
                            }
                            guard let data,
                                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                                  let params = root["params"] as? [String: Any],
                                  let auth = params["auth"] as? [String: Any]
                            else {
                                return
                            }
                            await capture.store(
                                token: auth["token"] as? String,
                                deviceToken: auth["deviceToken"] as? String)
                        })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://127.0.0.1:18789")),
                token: "shared-token",
                session: WebSocketSessionBox(session: session))

            try await channel.connect()

            let authSnapshot = await capture.load()
            #expect(authSnapshot.token == "shared-token")
            #expect(authSnapshot.deviceToken == "device-token")
            #expect(await channel.authSource() == .deviceToken)
        }
    }
}
