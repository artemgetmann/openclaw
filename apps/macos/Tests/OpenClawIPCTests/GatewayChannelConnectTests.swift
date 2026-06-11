import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayChannelConnectTests {
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

    @Test func `stored role device token wins over shared gateway token`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-channel-auth-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": root.path]) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "node",
                token: "stored-node-token",
                scopes: [])

            let sent = CapturedConnectAuth()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { _, message, sendIndex in
                            if sendIndex == 0 {
                                sent.record(message)
                            }
                        })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://127.0.0.1:18789")),
                token: "shared-operator-token",
                session: WebSocketSessionBox(session: session),
                connectOptions: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-macos",
                    clientMode: "node",
                    clientDisplayName: "OpenClaw Test"))

            try await channel.connect()

            #expect(await channel.authSource() == .deviceToken)
            #expect(sent.authToken() == "stored-node-token")
            #expect(sent.role() == "node")
        }
    }

    @Test func `operator shared gateway token wins over stored operator device token`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-channel-auth-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": root.path]) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "stale-operator-device-token",
                scopes: [])

            let sent = CapturedConnectAuth()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { _, message, sendIndex in
                            if sendIndex == 0 {
                                sent.record(message)
                            }
                        })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://127.0.0.1:18789")),
                token: "shared-operator-token",
                session: WebSocketSessionBox(session: session),
                connectOptions: GatewayConnectOptions(
                    role: "operator",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-macos",
                    clientMode: "ui",
                    clientDisplayName: "OpenClaw Test"))

            try await channel.connect()

            #expect(await channel.authSource() == .sharedToken)
            #expect(sent.authToken() == "shared-operator-token")
            #expect(sent.role() == "operator")
        }
    }
}

private final class CapturedConnectAuth: @unchecked Sendable {
    private let lock = NSLock()
    private var tokenValue: String?
    private var roleValue: String?

    func record(_ message: URLSessionWebSocketTask.Message) {
        let data: Data? = switch message {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let params = object["params"] as? [String: Any]
        else {
            return
        }
        let auth = params["auth"] as? [String: Any]
        self.lock.lock()
        self.tokenValue = auth?["token"] as? String
        self.roleValue = params["role"] as? String
        self.lock.unlock()
    }

    func authToken() -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.tokenValue
    }

    func role() -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.roleValue
    }
}
