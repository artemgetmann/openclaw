import Testing
@testable import OpenClaw

private typealias SnapshotAnyCodable = OpenClaw.AnyCodable

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
                    #expect(telegram["groupPolicy"] as? String == "allowlist")
                    #expect(telegram["allowFrom"] as? [String] == ["42"])
                    let groups = telegram["groups"] as? [String: Any]
                    let wildcardGroup = groups?["*"] as? [String: Any]
                    #expect(wildcardGroup?["requireMention"] as? Bool == false)
                    #expect(persistedGateway?["mode"] as? String == "local")
                }
    }

    @Test func `telegram bootstrap keeps the real local gateway token when draft was redacted`() async throws {
        var currentRoot: [String: Any] = [
            "gateway": [
                "auth": [
                    "mode": "token",
                    "token": "real-local-gateway-token",
                ],
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
                    store.configDraft = [
                        "gateway": [
                            "auth": [
                                "mode": "token",
                                "token": "__OPENCLAW_REDACTED__",
                            ],
                            "mode": "local",
                            "port": 19001,
                            "bind": "loopback",
                        ],
                    ]

                    let persisted = try await store.applyTelegramSetupBootstrap(
                        token: "123456:abc",
                        dmPolicy: "allowlist",
                        allowFrom: ["42"])

                    let gateway = currentRoot["gateway"] as? [String: Any]
                    let auth = gateway?["auth"] as? [String: Any]
                    let persistedGateway = persisted["gateway"] as? [String: Any]
                    let persistedAuth = persistedGateway?["auth"] as? [String: Any]

                    #expect(auth?["token"] as? String == "real-local-gateway-token")
                    #expect(persistedAuth?["token"] as? String == "real-local-gateway-token")
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
                    let groups = telegram["groups"] as? [String: Any]
                    let wildcardGroup = groups?["*"] as? [String: Any]

                    #expect(telegram["enabled"] as? Bool == false)
                    #expect(telegram["dmPolicy"] as? String == "allowlist")
                    #expect(telegram["groupPolicy"] as? String == "allowlist")
                    #expect(telegram["allowFrom"] as? [String] == ["42"])
                    #expect(wildcardGroup?["requireMention"] as? Bool == false)
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

    @Test func `telegram first task skips replay when live activity already proves completion`() {
        #expect(
            ChannelsStore.consumerTelegramFirstTaskReplayAction(
                activityAlreadyConfirmed: true) == .trustObservedLiveCompletion)
    }

    @Test func `telegram first task replays captured message when live activity has not completed yet`() {
        #expect(
            ChannelsStore.consumerTelegramFirstTaskReplayAction(
                activityAlreadyConfirmed: false) == .replayCapturedMessage)
    }

    @Test func `healthy telegram refresh promotes timed out setup once outbound activity proves completion`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupStatus =
                "Telegram setup is saved, but OpenClaw could not finish the first Telegram task. OpenClaw started the first Telegram task, but the setup handoff timed out before completion was confirmed."
            store.telegramSetupBaselineInboundAt = 1_000

            let snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["telegram"],
                channelLabels: ["telegram": "Telegram"],
                channelDetailLabels: nil,
                channelSystemImages: nil,
                channelMeta: nil,
                channels: [
                    "telegram": SnapshotAnyCodable([
                        "configured": true,
                        "running": true,
                        "mode": "polling",
                    ]),
                ],
                channelAccounts: [
                    "telegram": [
                        .init(
                            accountId: "default",
                            name: nil,
                            enabled: true,
                            configured: true,
                            linked: nil,
                            running: true,
                            connected: nil,
                            reconnectAttempts: nil,
                            lastConnectedAt: nil,
                            lastError: nil,
                            lastStartAt: nil,
                            lastStopAt: nil,
                            lastInboundAt: 1_000,
                            lastOutboundAt: 1_500,
                            lastProbeAt: nil,
                            mode: "polling",
                            dmPolicy: "allowlist",
                            allowFrom: ["1336356696"],
                            tokenSource: "config",
                            botTokenSource: nil,
                            appTokenSource: nil,
                            baseUrl: nil,
                            allowUnmentionedGroups: nil,
                            cliPath: nil,
                            dbPath: nil,
                            port: nil,
                            probe: nil,
                            audit: nil,
                            application: nil),
                    ],
                ],
                channelDefaultAccountId: ["telegram": "default"])

            store.snapshot = snapshot
            store._testReconcileTelegramSetupProgress(with: snapshot)

            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. First task verified.")
        }
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

    @Test func `telegram replay params keep messageId as integer`() throws {
        let store = ChannelsStore(isPreview: true)
        let params = try #require(store._testTelegramReplayGatewayParams(
            dm: TelegramSetupDirectMessage(
                updateId: 101,
                messageId: 202,
                chatId: 303,
                chatUsername: "jarvis_consumer_smoke_2",
                senderId: 404,
                senderUsername: "artem",
                senderFirstName: "Artem",
                text: "/start",
                caption: nil,
                date: 505,
                messageThreadId: nil)))

        let payload = try #require(params["payload"]?.value as? [String: Any])
        #expect(payload["messageId"] as? Int == 202)
        #expect(payload["updateId"] as? Int == 101)
        #expect(payload["chatId"] as? Int == 303)
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
