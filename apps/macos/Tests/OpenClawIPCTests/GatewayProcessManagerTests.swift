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

    @Test func `reconciliation repairs missing launchd registration while desired active`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                connectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: { false },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })

                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                // This is the stale state from the incident: socket/status truth still
                // says running, but launchd no longer owns a registered service.
                manager.setTestingStatus(.running(details: "stale app state"))
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                    manager.setTestingStatus(.stopped)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(daemonCalls == [[
                    "install",
                    "--force",
                    "--allow-shared-service-takeover",
                    "--port",
                    "\(GatewayEnvironment.gatewayPort())",
                    "--runtime",
                    "node",
                ]])
            }
    }

    @Test func `reconciliation leaves loaded launchd service untouched across checks`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                connectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        return true
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })

                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()
                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(loadedChecks == 2)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation task stops and no longer checks launchd when inactive`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                connectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                var loadedChecks = 0
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        return false
                    },
                    runDaemonCommand: { _, _, _ in nil })

                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                manager.startTestingLaunchAgentReconciliation()
                #expect(manager.testingLaunchAgentReconciliationIsRunning())

                manager.setTestingDesiredActive(false)
                #expect(!manager.testingLaunchAgentReconciliationIsRunning())

                // A late/manual tick models a suspended status read resuming after mode
                // changed. The inactive guard must stop before consulting launchd.
                await manager.testingReconcileLaunchAgentRegistrationNow()
                #expect(loadedChecks == 0)

                GatewayLaunchAgentManager._clearTestingHooks()
            }
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

    @Test func `stale launch agent entrypoint requires repair even when runtime env differs`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let packagedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw", isDirectory: true)
        let staleRoot = FileManager().temporaryDirectory
            .appendingPathComponent("source-openclaw-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: packagedRoot)
            try? FileManager().removeItem(at: staleRoot)
        }

        try FileManager().createDirectory(
            at: packagedRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try FileManager().createDirectory(
            at: staleRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: packagedRoot.appendingPathComponent("dist/index.js"))
        try Data().write(to: packagedRoot.appendingPathComponent("package.json"))
        try Data().write(to: packagedRoot.appendingPathComponent("openclaw.mjs"))
        try Data().write(to: staleRoot.appendingPathComponent("dist/index.js"))

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": packagedRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)

            let staleRuntimeRoot = staleRoot.appendingPathComponent(".openclaw", isDirectory: true)
            let staleConfig = staleRuntimeRoot.appendingPathComponent("openclaw.json")
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    staleRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    // This reproduces a source-owned service: both the entrypoint and
                    // runtime paths are stale, but the canonical label still belongs
                    // to the app and must be repaired before attaching.
                    "OPENCLAW_HOME": staleRuntimeRoot.path,
                    "OPENCLAW_STATE_DIR": staleRuntimeRoot.path,
                    "OPENCLAW_CONFIG_PATH": staleConfig.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": staleConfig.path,
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            #expect(!GatewayLaunchAgentManager.launchAgentMatchesCurrentRuntime())
            #expect(GatewayProcessManager.shared.testingLaunchAgentNeedsOwnershipRepair())
        }
    }

    @Test func `stale launch agent service identity requires repair even when runtime and entrypoint match`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let packagedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: packagedRoot)
        }

        try FileManager().createDirectory(
            at: packagedRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: packagedRoot.appendingPathComponent("dist/index.js"))
        try Data().write(to: packagedRoot.appendingPathComponent("package.json"))
        try Data().write(to: packagedRoot.appendingPathComponent("openclaw.mjs"))

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": packagedRoot.path,
            ])
        {
            let currentVersion = "2026.3.22"
            let currentBuild = "2026061103"
            GatewayLaunchAgentManager._setTestingHooks(
                currentServiceVersion: { currentVersion },
                currentServiceBuild: { currentBuild })
            defer { GatewayLaunchAgentManager._clearTestingHooks() }

            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)

            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    packagedRoot.appendingPathComponent("dist/index.js").path,
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
                    "OPENCLAW_SERVICE_VERSION": currentVersion,
                    // Missing OPENCLAW_SERVICE_BUILD reproduces a Sparkle-updated
                    // app with a launchd env block from before build markers existed.
                    "PATH": identity.stateDirURL
                        .appendingPathComponent("tools/node/bin", isDirectory: true)
                        .path,
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            #expect(GatewayLaunchAgentManager.launchAgentMatchesCurrentRuntime())
            #expect(GatewayLaunchAgentManager.currentEntrypointOwnership().matchesCurrentEntrypoint)
            #expect(GatewayProcessManager.shared.testingLaunchAgentNeedsOwnershipRepair())
        }
    }

}
