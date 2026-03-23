import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    @Test func `skips launch agent ensure while gateway start is already in progress`() {
        #expect(GatewayProcessManager._testShouldSkipLaunchAgentEnsure(for: .starting))
        #expect(!GatewayProcessManager._testShouldSkipLaunchAgentEnsure(for: .stopped))
    }

    @Test func `forced recovery bypasses stale running state`() {
        #expect(GatewayProcessManager._testShouldSkipGatewayStart(for: .running(details: nil), forceRecovery: false))
        #expect(!GatewayProcessManager._testShouldSkipGatewayStart(for: .running(details: nil), forceRecovery: true))
        #expect(GatewayProcessManager._testShouldSkipGatewayStart(for: .attachedExisting(details: "pid 1"), forceRecovery: false))
        #expect(!GatewayProcessManager._testShouldSkipGatewayStart(for: .attachedExisting(details: "pid 1"), forceRecovery: true))
        #expect(GatewayProcessManager._testShouldSkipGatewayStart(for: .starting, forceRecovery: true))
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
}
