import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TelegramSetupBootstrapTests {
    @Test func `telegram bootstrap merges onto latest config instead of stale empty draft`() async throws {
        var currentRoot: [String: Any] = [
            "gateway": [
                "mode": "local",
                "port": 19001,
                "bind": "loopback",
            ],
            "channels": [
                "telegram": [
                    "enabled": true,
                    "dmPolicy": "pairing",
                ],
            ],
        ]

        try await TestIsolation.withConfigStoreOverrides(
            .init(
                isRemoteMode: { false },
                loadLocal: { currentRoot },
                saveLocal: { root in currentRoot = root })) {
                    let store = ChannelsStore(isPreview: true)
                    store.configDraft = [:]

                    let persisted = try await store.applyTelegramSetupBootstrap(
                        token: "123456:abc",
                        dmPolicy: "allowlist",
                        allowFrom: ["42"])

                    let gateway = currentRoot["gateway"] as? [String: Any]
                    let telegram = ((currentRoot["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
                    let persistedGateway = persisted["gateway"] as? [String: Any]

                    #expect(gateway?["mode"] as? String == "local")
                    #expect(gateway?["port"] as? Int == 19001)
                    #expect(telegram["enabled"] as? Bool == true)
                    #expect(telegram["dmPolicy"] as? String == "allowlist")
                    #expect(telegram["allowFrom"] as? [String] == ["42"])
                    #expect(persistedGateway?["mode"] as? String == "local")
                }
    }

    @Test func `telegram bootstrap can persist allowlist while keeping telegram disabled`() async throws {
        var currentRoot: [String: Any] = [
            "gateway": [
                "mode": "local",
                "port": 19001,
                "bind": "loopback",
            ],
            "channels": [
                "telegram": [
                    "enabled": true,
                    "dmPolicy": "pairing",
                ],
            ],
        ]

        try await TestIsolation.withConfigStoreOverrides(
            .init(
                isRemoteMode: { false },
                loadLocal: { currentRoot },
                saveLocal: { root in currentRoot = root })) {
                    let store = ChannelsStore(isPreview: true)
                    store.configDraft = [:]

                    let persisted = try await store.applyTelegramSetupBootstrap(
                        token: "123456:abc",
                        dmPolicy: "allowlist",
                        allowFrom: ["42"],
                        enabled: false)

                    let telegram = ((currentRoot["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
                    let persistedTelegram = ((persisted["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]

                    #expect(telegram["enabled"] as? Bool == false)
                    #expect(telegram["dmPolicy"] as? String == "allowlist")
                    #expect(telegram["allowFrom"] as? [String] == ["42"])
                    #expect(persistedTelegram["enabled"] as? Bool == false)
                }
    }

    @Test func `telegram bootstrap throws when persisted config does not keep lockin`() async throws {
        let baselineRoot: [String: Any] = [
            "gateway": [
                "mode": "local",
                "port": 19001,
                "bind": "loopback",
            ],
            "channels": [
                "telegram": [
                    "enabled": true,
                    "dmPolicy": "pairing",
                ],
            ],
        ]
        var currentRoot = baselineRoot

        try await TestIsolation.withConfigStoreOverrides(
            .init(
                isRemoteMode: { false },
                loadLocal: { currentRoot },
                saveLocal: { _ in
                    // Simulate a write path that silently failed to persist the new DM policy.
                    currentRoot = baselineRoot
                })) {
                    let store = ChannelsStore(isPreview: true)

                    await #expect(throws: Error.self) {
                        _ = try await store.applyTelegramSetupBootstrap(
                            token: "123456:abc",
                            dmPolicy: "allowlist",
                            allowFrom: ["42"])
                    }
                }
    }

    @Test func `telegram replay timeout recovery reenables telegram after reply started`() {
        let decision = ChannelsStore.consumerTelegramReplayDecision(
            replyStarted: true,
            replyCompleted: false,
            error: "timeout")

        #expect(decision.shouldReenableTelegram)
        #expect(decision.shouldWaitForActivityConfirmation)
        #expect(!decision.shouldTrustReplayCompletion)
    }

    @Test func `telegram replay hard failure keeps telegram disabled until retry`() {
        let decision = ChannelsStore.consumerTelegramReplayDecision(
            replyStarted: false,
            replyCompleted: nil,
            error: "boot failed")

        #expect(!decision.shouldReenableTelegram)
        #expect(!decision.shouldWaitForActivityConfirmation)
        #expect(!decision.shouldTrustReplayCompletion)
    }

    @Test func `telegram bootstrap reconnect retries until the restarted gateway accepts auth`() async {
        actor Recorder {
            var events: [String] = []
            var probeAttempts = 0

            func append(_ event: String) {
                self.events.append(event)
            }

            func nextProbeAttempt() -> Int {
                self.probeAttempts += 1
                return self.probeAttempts
            }

            func snapshot() -> [String] {
                self.events
            }
        }

        enum TestReconnectError: Error {
            case tokenMismatch
        }

        let recorder = Recorder()
        let recovered = await ChannelsStore._testRecoverConsumerGatewayAfterConfigBootstrap(
            retryDelayNanoseconds: 1,
            maxAttempts: 4,
            shutdown: {
                await recorder.append("shutdown")
            },
            refreshEndpoint: {
                await recorder.append("refresh-endpoint")
            },
            refreshConnection: {
                await recorder.append("refresh-connection")
            },
            probe: {
                let attempt = await recorder.nextProbeAttempt()
                await recorder.append("probe-\(attempt)")
                if attempt < 3 {
                    throw TestReconnectError.tokenMismatch
                }
            },
            sleep: { _ in
                await recorder.append("sleep")
            })

        let events = await recorder.snapshot()
        #expect(recovered)
        #expect(events == [
            "shutdown",
            "refresh-endpoint",
            "refresh-connection",
            "probe-1",
            "sleep",
            "shutdown",
            "refresh-endpoint",
            "refresh-connection",
            "probe-2",
            "sleep",
            "shutdown",
            "refresh-endpoint",
            "refresh-connection",
            "probe-3",
        ])
    }

    @Test func `telegram bootstrap reconnect gives up after bounded retries`() async {
        actor Recorder {
            var shutdownCalls = 0
            var sleepCalls = 0

            func noteShutdown() {
                self.shutdownCalls += 1
            }

            func noteSleep() {
                self.sleepCalls += 1
            }

            func snapshot() -> (shutdowns: Int, sleeps: Int) {
                (self.shutdownCalls, self.sleepCalls)
            }
        }

        enum TestReconnectError: Error {
            case tokenMismatch
        }

        let recorder = Recorder()
        let recovered = await ChannelsStore._testRecoverConsumerGatewayAfterConfigBootstrap(
            retryDelayNanoseconds: 1,
            maxAttempts: 3,
            shutdown: {
                await recorder.noteShutdown()
            },
            refreshEndpoint: {},
            refreshConnection: {},
            probe: {
                throw TestReconnectError.tokenMismatch
            },
            sleep: { _ in
                await recorder.noteSleep()
            })

        let snapshot = await recorder.snapshot()
        #expect(!recovered)
        #expect(snapshot.shutdowns == 3)
        #expect(snapshot.sleeps == 2)
    }
}
