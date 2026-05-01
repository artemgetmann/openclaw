import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    @Test func `gateway readiness timeout allows real launchd restart budget`() {
        #expect(GatewayProcessManager.gatewayReadinessTimeout >= 20)
    }

    @Test func `clears last failure when health succeeds`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        manager.setTestingLastFailureReason("health failed")
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
    }

    @Test func `launchd ensure attaches healthy canonical gateway without reinstall`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    "/Users/user/Programming_Projects/openclaw/dist/index.js",
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { task, message, sendIndex in
                            guard sendIndex > 0 else { return }
                            guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                            task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                        })
                })
            let url = try #require(URL(string: "ws://127.0.0.1:\(identity.gatewayPort)"))
            let connection = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))

            var daemonCalls: [[String]] = []
            GatewayLaunchAgentManager._setTestingHooks(
                launchAgentWriteDisabled: { false },
                readDaemonLoaded: { false },
                runDaemonCommand: { args, _, _ in
                    daemonCalls.append(args)
                    return nil
                })
            let manager = GatewayProcessManager.shared
            manager.setTestingConnection(connection)
            manager.setTestingStatus(.starting)
            defer {
                GatewayLaunchAgentManager._clearTestingHooks()
                manager.setTestingConnection(nil)
                manager.setTestingStatus(.stopped)
                manager.setTestingDesiredActive(false)
            }

            await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(daemonCalls.isEmpty)
            if case .attachedExisting = manager.status {
                // Expected: the app attached to the already-healthy canonical gateway.
            } else {
                Issue.record("Expected attachedExisting, got \(manager.status)")
            }
        }
    }
}
