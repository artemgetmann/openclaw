import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor GatewayRecoveryNotificationRecorder {
    private(set) var incidents: [GatewayRecoveryIncident] = []

    func record(_ incident: GatewayRecoveryIncident) {
        self.incidents.append(incident)
    }

    func count() -> Int {
        self.incidents.count
    }
}

private actor GatewayHealthAttemptRecorder {
    private(set) var attempts = 0
    private var managedJobWasObserved = false

    func shouldReturnHealthy() -> Bool {
        self.attempts += 1
        return self.managedJobWasObserved
    }

    func recordManagedJobObservation() {
        self.managedJobWasObserved = true
    }
}

/// Process-manager tests share the launch-agent suite because both mutate
/// `GatewayLaunchAgentManager`'s process-wide DEBUG hooks. One serialized suite
/// is the scheduler boundary that prevents those hooks from overlapping.
@MainActor
extension GatewayLaunchAgentManagerTests {
    @Test func `gateway readiness timeout allows real launchd restart budget`() {
        #expect(GatewayProcessManager.gatewayReadinessTimeout >= 20)
        #expect(GatewayProcessManager.gatewayMaximumReadinessTimeout >= 180)
        #expect(GatewayProcessManager.gatewayMaximumReadinessTimeout <= 300)
    }

    @Test func `launchd running parser requires state and live pid`() {
        #expect(GatewayProcessManager.launchdPrintDescribesRunningJob("""
        gui/501/ai.jarvis.gateway = {
            state = running
            pid = 4242
        }
        """))
        #expect(!GatewayProcessManager.launchdPrintDescribesRunningJob("""
        gui/501/ai.jarvis.gateway = {
            state = waiting
        }
        """))
        #expect(!GatewayProcessManager.launchdPrintDescribesRunningJob("state = running"))
    }

    @Test func `slow but running managed gateway stays starting and suppresses false incident`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }
        let healthAttempts = GatewayHealthAttemptRecorder()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard await healthAttempts.shouldReturnHealthy(),
                              let id = GatewayWebSocketTestSupport.requestID(from: message)
                        else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager(
                    recoveryReadinessTimeout: 0,
                    maximumReadinessTimeout: 10,
                    recoveryNotificationSender: { _ in
                        Issue.record("running cold start must not notify a recovery incident")
                    },
                    managedJobRunningProbe: {
                        await healthAttempts.recordManagedJobObservation()
                        return true
                    })
                manager.setTestingConnection(connection)
                manager.setTestingDesiredActive(true)
                defer {
                    manager.setTestingConnection(nil)
                    manager.setTestingDesiredActive(false)
                }

                let ready = await manager.testingConfirmSlowManagedGatewayWithoutHealthySideEffects()

                #expect(ready)
                #expect(manager.status == .starting)
                #expect(manager.testingRecoveryIncident() == nil)
                #expect(await healthAttempts.attempts >= 2)
            }
    }

    @Test func `running but hung managed gateway eventually presents incident`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }
        let recorder = GatewayRecoveryNotificationRecorder()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, _, sendIndex in
                        guard sendIndex > 0 else { return }
                        throw URLError(.cannotConnectToHost)
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager(
                    recoveryReadinessTimeout: 0,
                    maximumReadinessTimeout: 0.05,
                    recoveryNotificationSender: { incident in
                        await recorder.record(incident)
                    },
                    managedJobRunningProbe: { true })
                manager.setTestingConnection(connection)
                manager.setTestingDesiredActive(true)
                defer {
                    manager.setTestingConnection(nil)
                    manager.setTestingDesiredActive(false)
                }

                let ready = await manager.testingConfirmSlowManagedGatewayWithoutHealthySideEffects()

                #expect(!ready)
                #expect(manager.testingRecoveryIncident() != nil)
                #expect(await recorder.count() == 1)
            }
    }

    @Test func `recovery tracker waits for bounded unverifiable observations`() {
        var tracker = GatewayRecoveryIncidentTracker()

        let firstUnknownRequiresVerification = tracker.recordServiceObservation(nil)
        #expect(!firstUnknownRequiresVerification)
        #expect(tracker.consecutiveUnverifiableChecks == 1)
        let secondUnknownRequiresVerification = tracker.recordServiceObservation(nil)
        #expect(secondUnknownRequiresVerification)
        #expect(tracker.consecutiveUnverifiableChecks == GatewayRecoveryIncidentTracker.unverifiableCheckLimit)

        // Any definitive service observation breaks the consecutive-unknown run.
        let loadedRequiresVerification = tracker.recordServiceObservation(true)
        #expect(!loadedRequiresVerification)
        #expect(tracker.consecutiveUnverifiableChecks == 0)
        let newUnknownRequiresVerification = tracker.recordServiceObservation(nil)
        #expect(!newUnknownRequiresVerification)
    }

    @Test func `recovery tracker deduplicates notification until healthy reset`() {
        var tracker = GatewayRecoveryIncidentTracker()

        let firstFailureShouldNotify = tracker.recordUnavailable()
        #expect(firstFailureShouldNotify)
        #expect(tracker.isIncidentActive)
        let repeatedFailureShouldNotify = tracker.recordUnavailable()
        #expect(!repeatedFailureShouldNotify)

        tracker.recordHealthy()
        #expect(!tracker.isIncidentActive)
        let nextIncidentShouldNotify = tracker.recordUnavailable()
        #expect(nextIncidentShouldNotify)
    }

    @Test func `external watchdog receipt activates card without duplicate notification`() {
        var tracker = GatewayRecoveryIncidentTracker()

        tracker.recordExternallyNotifiedUnavailable()

        #expect(tracker.isIncidentActive)
        let shouldNotifyAgain = tracker.recordUnavailable()
        #expect(!shouldNotifyAgain)
        tracker.recordHealthy()
        #expect(!tracker.isIncidentActive)
    }

    @Test func `packaged watchdog path accepts installed Jarvis and rejects source builds`() {
        let installed = URL(fileURLWithPath: "/Applications/Jarvis.app", isDirectory: true)
        let userHome = URL(fileURLWithPath: "/Users/test", isDirectory: true)
        let userInstalled = userHome
            .appendingPathComponent("Applications/Jarvis.app", isDirectory: true)
        let source = URL(
            fileURLWithPath: "/Users/test/Programming_Projects/openclaw/dist/Jarvis.app",
            isDirectory: true)
        let downloads = userHome
            .appendingPathComponent("Downloads/Jarvis.app", isDirectory: true)
        let mounted = URL(fileURLWithPath: "/Volumes/Jarvis/Jarvis.app", isDirectory: true)

        #expect(GatewayLaunchAgentManager.packagedGatewayWatchdogExecutablePath(
            bundleURL: installed,
            homeURL: userHome,
            isExecutable: { _ in true }) ==
            "/Applications/Jarvis.app/Contents/MacOS/JarvisGatewayWatchdog")
        #expect(GatewayLaunchAgentManager.packagedGatewayWatchdogExecutablePath(
            bundleURL: userInstalled,
            homeURL: userHome,
            isExecutable: { _ in true }) ==
            "/Users/test/Applications/Jarvis.app/Contents/MacOS/JarvisGatewayWatchdog")
        #expect(GatewayLaunchAgentManager.packagedGatewayWatchdogExecutablePath(
            bundleURL: source,
            homeURL: userHome,
            isExecutable: { _ in true }) == nil)
        #expect(GatewayLaunchAgentManager.packagedGatewayWatchdogExecutablePath(
            bundleURL: downloads,
            homeURL: userHome,
            isExecutable: { _ in true }) == nil)
        #expect(GatewayLaunchAgentManager.packagedGatewayWatchdogExecutablePath(
            bundleURL: mounted,
            homeURL: userHome,
            isExecutable: { _ in true }) == nil)
    }

    @Test func `unverifiable service state does not alarm while health RPC works`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

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

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: { nil })
                let manager = GatewayProcessManager(
                    recoveryReadinessTimeout: 0.5,
                    recoveryNotificationSender: { _ in
                        Issue.record("healthy RPC must veto the recovery notification")
                    })
                manager.setTestingConnection(connection)
                manager.setTestingDesiredActive(true)
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingConnection(nil)
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()
                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(manager.testingRecoveryIncident() == nil)
            }
    }

    @Test func `shared recovery incident notification deduplicates and resets after health`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }
        let recorder = GatewayRecoveryNotificationRecorder()

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager(
                    recoveryReadinessTimeout: 0,
                    recoveryNotificationSender: { incident in
                        await recorder.record(incident)
                    })
                manager.setTestingDesiredActive(true)
                defer { manager.setTestingDesiredActive(false) }

                await manager.testingPresentRecoveryIncident()
                await manager.testingPresentRecoveryIncident()

                #expect(manager.testingRecoveryIncident()?.actionTitle == "Restart Jarvis")
                #expect(await recorder.count() == 1)

                manager.testingRecordHealthyRPC()
                #expect(manager.testingRecoveryIncident() == nil)

                await manager.testingPresentRecoveryIncident()
                #expect(await recorder.count() == 2)
            }
    }

    @Test func `telegram recovery activates only after automatic recovery is exhausted`() async {
        let recorder = GatewayRecoveryNotificationRecorder()
        let manager = GatewayProcessManager(recoveryNotificationSender: { incident in
            await recorder.record(incident)
        })
        manager.setTestingDesiredActive(true)
        defer { manager.setTestingDesiredActive(false) }

        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .providerRestart, providerRestartAttempts: 1, updatedAt: 1000),
            nowMs: 2000)
        #expect(manager.testingRecoveryIncident() == nil)
        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .gatewayRestartRequested, providerRestartAttempts: 2, updatedAt: 2000),
            nowMs: 3000)
        #expect(manager.testingRecoveryIncident() == nil)

        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .exhausted, providerRestartAttempts: 2, updatedAt: 3000),
            nowMs: 4000)
        #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)
        #expect(await recorder.count() == 1)
    }

    @Test func `healthy gateway does not clear exhausted telegram recovery`() async {
        let manager = GatewayProcessManager(recoveryNotificationSender: { _ in })
        manager.setTestingDesiredActive(true)
        defer { manager.setTestingDesiredActive(false) }

        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .exhausted, providerRestartAttempts: 2, updatedAt: 1000),
            nowMs: 2000)
        manager.testingRecordHealthyRPC()

        #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)
    }

    @Test func `successful telegram poll clears recovery while next poll is in flight`() async {
        let manager = GatewayProcessManager(recoveryNotificationSender: { _ in })
        manager.setTestingDesiredActive(true)
        defer { manager.setTestingDesiredActive(false) }

        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .exhausted, providerRestartAttempts: 2, updatedAt: 1000),
            nowMs: 2000)
        await manager.testingRecordTelegramRecoveryObservation(
            .init(lastPollSuccessAt: 2000, lastPollOutcome: "in-flight"),
            nowMs: 3000)

        #expect(manager.testingRecoveryIncident() == nil)
    }

    @Test func `stale or pre incident telegram poll cannot clear recovery`() async {
        let manager = GatewayProcessManager(recoveryNotificationSender: { _ in })
        manager.setTestingDesiredActive(true)
        defer { manager.setTestingDesiredActive(false) }

        await manager.testingRecordTelegramRecoveryObservation(
            .init(phase: .exhausted, providerRestartAttempts: 2, updatedAt: 200_000),
            nowMs: 201_000)
        await manager.testingRecordTelegramRecoveryObservation(
            .init(lastPollSuccessAt: 200_000, lastPollOutcome: "error"),
            nowMs: 201_000)
        #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)

        await manager.testingRecordTelegramRecoveryObservation(
            .init(lastPollSuccessAt: 201_000, lastPollOutcome: "in-flight"),
            nowMs: 381_001)
        #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)

        await manager.testingRecordTelegramRecoveryObservation(
            .init(lastPollOutcome: "error"),
            nowMs: 202_000)
        #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)
    }

    @Test func `telegram recovery notification deduplicates until polling proof`() async {
        let recorder = GatewayRecoveryNotificationRecorder()
        let manager = GatewayProcessManager(recoveryNotificationSender: { incident in
            await recorder.record(incident)
        })
        manager.setTestingDesiredActive(true)
        defer { manager.setTestingDesiredActive(false) }

        let exhausted = TelegramRecoveryObservation(
            phase: .exhausted,
            providerRestartAttempts: 2,
            updatedAt: 1000)
        await manager.testingRecordTelegramRecoveryObservation(exhausted, nowMs: 2000)
        await manager.testingRecordTelegramRecoveryObservation(exhausted, nowMs: 3000)

        #expect(await recorder.count() == 1)
    }

    @Test func `channels status decodes sticky telegram polling success proof`() throws {
        let snapshot = try JSONDecoder().decode(
            ChannelsStatusSnapshot.self,
            from: Data("""
            {
              "ts": 5000,
              "channelOrder": ["telegram"],
              "channelLabels": {"telegram": "Telegram"},
              "channels": {},
              "channelAccounts": {
                "telegram": [{
                  "accountId": "default",
                  "lastPollCompletedAt": 4001,
                  "lastPollSuccessAt": 4000,
                  "lastPollOutcome": "in-flight",
                  "telegramRecovery": {
                    "phase": "exhausted",
                    "providerRestartAttempts": 2,
                    "updatedAt": 3000
                  }
                }]
              },
              "channelDefaultAccountId": {"telegram": "default"}
            }
            """.utf8))

        #expect(snapshot.telegramRecoveryObservation() == .init(
            phase: .exhausted,
            providerRestartAttempts: 2,
            updatedAt: 3000,
            lastPollSuccessAt: 4000,
            lastPollOutcome: "in-flight"))
    }

    @Test func `launch agent reconciliation always observes channels status`() async throws {
        let snapshot = try JSONDecoder().decode(
            ChannelsStatusSnapshot.self,
            from: Data("""
            {
              "ts": 4000,
              "channelOrder": ["telegram"],
              "channelLabels": {"telegram": "Telegram"},
              "channels": {},
              "channelAccounts": {
                "telegram": [{
                  "accountId": "default",
                  "lastPollOutcome": "unhealthy",
                  "telegramRecovery": {
                    "phase": "exhausted",
                    "providerRestartAttempts": 2,
                    "updatedAt": 3000
                  }
                }]
              },
              "channelDefaultAccountId": {"telegram": "default"}
            }
            """.utf8))

        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: nil,
        ]) {
            GatewayLaunchAgentManager._setTestingHooks(
                launchAgentWriteDisabled: { false },
                readDaemonLoaded: { true })
            let manager = GatewayProcessManager(
                recoveryNotificationSender: { _ in },
                channelsStatusProvider: { snapshot })
            manager.setTestingDesiredActive(true)
            defer {
                GatewayLaunchAgentManager._clearTestingHooks()
                manager.setTestingDesiredActive(false)
            }

            await manager.testingReconcileLaunchAgentRegistrationNow()

            #expect(manager.testingRecoveryIncident()?.kind == .telegramOffline)
        }
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
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
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
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
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

    @Test func `reconciliation treats indeterminate launchd status as no-op`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        return nil
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

                #expect(loadedChecks == 1)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation revalidates inactive state after launchd action query`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        // The third read is GatewayLaunchAgentManager's action query,
                        // after the reconciler's two definitive missing observations.
                        if loadedChecks == 3 {
                            manager.setTestingDesiredActive(false)
                        }
                        return false
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(loadedChecks == 3)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation revalidates remote mode after launchd action query`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        if loadedChecks == 3 {
                            UserDefaults.standard.set(
                                AppState.ConnectionMode.remote.rawValue,
                                forKey: connectionModeKey)
                        }
                        return false
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(loadedChecks == 3)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation revalidates attach-only mode after launchd action query`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var writeDisabled = false
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { writeDisabled },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        if loadedChecks == 3 {
                            writeDisabled = true
                        }
                        return false
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(loadedChecks == 3)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation suppresses mutation when cancelled during launchd action query`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        if loadedChecks == 3 {
                            withUnsafeCurrentTask { $0?.cancel() }
                        }
                        return false
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                let reconciliation = Task { @MainActor in
                    await manager.testingReconcileLaunchAgentRegistrationNow()
                }
                await reconciliation.value

                #expect(loadedChecks == 3)
                #expect(daemonCalls.isEmpty)
            }
    }

    @Test func `reconciliation uninstalls fresh registration when authority is revoked during command`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var loadedChecks = 0
                var daemonCalls: [[String]] = []
                var compensatingRollbackWasCancelled: Bool?
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: {
                        loadedChecks += 1
                        return false
                    },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        if args.first == "install" {
                            // Model ownership changing while the successful
                            // launchd command is suspended in a cancelled task.
                            withUnsafeCurrentTask { $0?.cancel() }
                            manager.setTestingDesiredActive(false)
                        } else if args == ["uninstall"] {
                            compensatingRollbackWasCancelled = Task.isCancelled
                        }
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(loadedChecks == 3)
                #expect(daemonCalls == [
                    [
                        "install",
                        "--force",
                        "--allow-shared-service-takeover",
                        "--port",
                        "\(GatewayEnvironment.gatewayPort())",
                        "--runtime",
                        "node",
                    ],
                    ["uninstall"],
                ])
                #expect(compensatingRollbackWasCancelled == false)
            }
    }

    @Test func `reconciliation compensates failed mutation after authority is revoked`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: { false },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        if args.first == "install" {
                            // A nonzero command can still leave launchd partially
                            // mutated before reporting its failure.
                            manager.setTestingDesiredActive(false)
                            return "simulated partial install failure"
                        }
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
                }

                await manager.testingReconcileLaunchAgentRegistrationNow()

                #expect(daemonCalls == [
                    [
                        "install",
                        "--force",
                        "--allow-shared-service-takeover",
                        "--port",
                        "\(GatewayEnvironment.gatewayPort())",
                        "--runtime",
                        "node",
                    ],
                    ["uninstall"],
                ])
            }
    }

    @Test func `old reconciliation does not stop service owned by newer active generation`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: { false },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        if args.first == "install" {
                            // The old command returns after stop/re-enable created
                            // a new reconciliation owner for the same local service.
                            withUnsafeCurrentTask { $0?.cancel() }
                            manager.setTestingDesiredActive(false)
                            manager.setTestingDesiredActive(true)
                            manager.startTestingLaunchAgentReconciliation()
                        }
                        return nil
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
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

    @Test func `detached compensation does not uninstall registration claimed before rollback executes`() async {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
            ]) {
                let manager = GatewayProcessManager()
                manager.setTestingDesiredActive(true)
                var daemonCalls: [[String]] = []
                GatewayLaunchAgentManager._setTestingHooks(
                    launchAgentWriteDisabled: { false },
                    readDaemonLoaded: { false },
                    runDaemonCommand: { args, _, _ in
                        daemonCalls.append(args)
                        if args.first == "install" {
                            withUnsafeCurrentTask { $0?.cancel() }
                            manager.setTestingDesiredActive(false)
                        }
                        return nil
                    },
                    beforeCompensatingRollback: {
                        // The parent already observed revocation and scheduled its
                        // detached rollback. A new generation now owns the service
                        // before that rollback reaches the launchd command.
                        manager.setTestingDesiredActive(true)
                        manager.startTestingLaunchAgentReconciliation()
                    })
                defer {
                    GatewayLaunchAgentManager._clearTestingHooks()
                    manager.setTestingDesiredActive(false)
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
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
            ],
            defaults: [
                gatewayManagerStandardConnectionModeKey: AppState.ConnectionMode.local.rawValue,
                gatewayManagerConsumerConnectionModeKey: AppState.ConnectionMode.local.rawValue,
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
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
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
                "OPENCLAW_CONFIG_PATH": gatewayManagerEmptyConfigPath,
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
