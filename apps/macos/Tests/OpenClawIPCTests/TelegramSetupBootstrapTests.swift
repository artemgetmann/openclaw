import Foundation
import Testing
@testable import OpenClaw

private typealias SnapshotAnyCodable = OpenClaw.AnyCodable

private actor ManagedTelegramRequestCounter {
    private var startCalls = 0

    func recordStart() {
        self.startCalls += 1
    }

    func value() -> Int {
        self.startCalls
    }
}

private actor TelegramBootstrapEventRecorder {
    private var events: [String] = []

    func record(_ event: String) {
        self.events.append(event)
    }

    func value() -> [String] {
        self.events
    }
}

private func makeConsumerTelegramSnapshot(
    running: Bool,
    inboundAt: Double?,
    outboundAt: Double?,
    snapshotTs: Double = 1_700_000_180,
    botId: Int = 123,
    username: String = "openclawbot"
) -> ChannelsStatusSnapshot {
    ChannelsStatusSnapshot(
        ts: snapshotTs,
        channelOrder: ["telegram"],
        channelLabels: ["telegram": "Telegram"],
        channelDetailLabels: nil,
        channelSystemImages: nil,
        channelMeta: nil,
        channels: [
            "telegram": SnapshotAnyCodable([
                "configured": true,
                "running": running,
                "mode": "polling",
                "probe": [
                    "ok": true,
                    "status": 200,
                    "bot": ["id": botId, "username": username],
                ],
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
                    running: running,
                    connected: nil,
                    reconnectAttempts: nil,
                    lastConnectedAt: nil,
                    lastError: nil,
                    lastStartAt: nil,
                    lastStopAt: nil,
                    lastInboundAt: inboundAt,
                    lastOutboundAt: outboundAt,
                    lastProbeAt: nil,
                    mode: "polling",
                    dmPolicy: "allowlist",
                    allowFrom: ["42"],
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
}

@Suite(.serialized)
@MainActor
struct TelegramSetupBootstrapTests {
    @Test func `consumer telegram setup field reads nested default-account token`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            "JARVIS_ACCOUNT_ACCESS_TOKEN": nil,
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.configDraft = [:]

            store._testApplyLoadedConfigRoot([
                "channels": [
                    "telegram": [
                        "accounts": [
                            "default": [
                                "botToken": "123456:abc",
                            ],
                        ],
                    ],
                ],
            ])

            #expect(store.telegramSetupToken == "123456:abc")
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

    @Test func `telegram replay does not trust started-only result without confirmed reply`() {
        let decision = ChannelsStore.consumerTelegramReplayDecision(
            replyStarted: true,
            replyCompleted: nil,
            error: nil)

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

    @Test func `verify telegram prefers pending pairing before live activity wait`() {
        #expect(
            ChannelsStore.consumerTelegramFirstTaskVerificationRoute(
                hasPendingPairing: true,
                looksLive: true) == .pendingPairing)
        #expect(
            ChannelsStore.consumerTelegramFirstTaskVerificationRoute(
                hasPendingPairing: false,
                looksLive: true) == .liveActivity)
        #expect(
            ChannelsStore.consumerTelegramFirstTaskVerificationRoute(
                hasPendingPairing: false,
                looksLive: false) == .directMessageCapture)
    }

    @Test func `telegram setup skips redundant bootstrap write when polling provider was already paused`() {
        #expect(
            !ChannelsStore.consumerTelegramNeedsBootstrapBeforeReplay(
                pausedPollingProvider: true))
        #expect(
            ChannelsStore.consumerTelegramNeedsBootstrapBeforeReplay(
                pausedPollingProvider: false))
    }

    @Test func `telegram replay retries when the gateway socket drops during planned restart`() {
        let socketError = NSError(
            domain: "gateway",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "gateway receive: The operation couldn't be completed. Socket is not connected"])
        let droppedError = NSError(
            domain: "gateway",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Gateway connection dropped; gateway likely restarted; retry."])
        let unrelatedError = NSError(
            domain: "gateway",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "permission denied"])

        #expect(ChannelsStore.consumerTelegramReplayShouldRetryAfterRestart(socketError))
        #expect(ChannelsStore.consumerTelegramReplayShouldRetryAfterRestart(droppedError))
        #expect(!ChannelsStore.consumerTelegramReplayShouldRetryAfterRestart(unrelatedError))
    }

    @Test func `enabled telegram bootstrap recovery restarts gateway before reconnect probe`() async {
        let events = TelegramBootstrapEventRecorder()

        let recovered = await ChannelsStore._testRecoverConsumerGatewayAfterConfigBootstrap(
            maxAttempts: 1,
            restartGateway: {
                await events.record("restart")
            },
            shutdown: {
                await events.record("shutdown")
            },
            refreshEndpoint: {
                await events.record("endpoint")
            },
            refreshConnection: {
                await events.record("connect")
            },
            probe: {
                await events.record("probe")
            })

        #expect(recovered)
        #expect(await events.value() == ["restart", "shutdown", "endpoint", "connect", "probe"])
    }

    @Test func `telegram replay status hides local gateway plumbing`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let rawError = "WebSocket connect failed at ws://127.0.0.1:57483/gateway: connection refused"
            let status = ChannelsStore.consumerTelegramFirstTaskReplayStatusMessage(for: rawError)

            #expect(status != nil)
            #expect(status?.contains("ws://127.0.0.1") == false)
            #expect(status?.contains("connection refused") == false)
            #expect(status?.contains("Telegram setup is saved") == true)
            #expect(status?.contains("try Verify Telegram again") == true)
            #expect(status?.localizedCaseInsensitiveContains("gateway") == false)
            #expect(status?.localizedCaseInsensitiveContains("runtime") == false)
        }
    }

    @Test func `telegram approved recovery copy matches verify telegram button`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let status = ChannelsStore.consumerTelegramApprovedNeedsFreshMessageStatus()

            #expect(status == "Telegram is approved. Jarvis is still starting; wait a moment, then click Verify Telegram again.")
            #expect(status.contains("Verify first task") == false)
            #expect(status.localizedCaseInsensitiveContains("gateway") == false)
            #expect(status.localizedCaseInsensitiveContains("OpenClaw") == false)
        }
    }

    @Test func `consumer telegram first task instruction asks for the required dm before verify`() {
        let instruction = ChannelsStore.consumerTelegramFirstTaskInstruction

        #expect(instruction == "Tap Start in Telegram, send \"Wake up, my friend\", then click Verify Telegram.")
        #expect(instruction.contains("Tap Start"))
        #expect(instruction.contains("\"Wake up, my friend\""))
        #expect(instruction.contains("Verify Telegram"))
        #expect(instruction != "Tap Start in Telegram, then click Verify Telegram.")
        #expect(instruction.contains("Tap Start in Telegram, then click Verify Telegram.") == false)
    }

    @Test func `healthy telegram refresh promotes timed out setup once paired activity proves completion`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupStatus =
                "Telegram setup is saved, but Jarvis could not finish the first Telegram task. Jarvis started the first Telegram task, but the setup handoff timed out before completion was confirmed."
            store.telegramSetupBaselineInboundAt = 1_700_000_000
            store.telegramSetupBaselineOutboundAt = 1_700_000_000

            let snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_030,
                outboundAt: 1_700_000_060,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            store.snapshot = snapshot
            store._testReconcileTelegramSetupProgress(with: snapshot)

            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. Chat approved.")
        }
    }

    @Test func `stale invalid-token status clears once live telegram activity proves the first task`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupStatus = "Invalid Telegram token."

            let snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_000,
                outboundAt: 1_700_000_090,
                snapshotTs: 1_700_000_150,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            store.snapshot = snapshot
            store._testReconcileTelegramSetupProgress(with: snapshot)

            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. Chat approved.")
        }
    }

    @Test func `live telegram activity does not verify without an outbound bot reply`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupStatus = "Invalid Telegram token."

            let snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_000,
                outboundAt: nil,
                snapshotTs: 1_700_000_060,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            store.snapshot = snapshot

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(store.telegramSetupStatus == "Invalid Telegram token.")
            #expect(!store.consumerTelegramFirstTaskVerified)
        }
    }

    @Test func `live telegram activity does not verify when the bot reply predates the user dm`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupStatus = "Invalid Telegram token."

            let snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_090,
                outboundAt: 1_700_000_000,
                snapshotTs: 1_700_000_120,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            store.snapshot = snapshot

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(store.telegramSetupStatus == "Invalid Telegram token.")
            #expect(!store.consumerTelegramFirstTaskVerified)
        }
    }

    @Test func `live telegram activity requires inbound and outbound to advance past setup baseline`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupBaselineInboundAt = 1_700_000_000
            store.telegramSetupBaselineOutboundAt = 1_700_000_010
            store.telegramSetupStatus = "Waiting for Jarvis to finish your first Telegram task..."

            store.snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_020,
                outboundAt: 1_700_000_010,
                snapshotTs: 1_700_000_030,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(!store.consumerTelegramFirstTaskVerified)

            store.snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_000,
                outboundAt: 1_700_000_020,
                snapshotTs: 1_700_000_030,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(!store.consumerTelegramFirstTaskVerified)
        }
    }

    @Test func `live telegram verification accepts recent paired activity even when baseline caught the same reply`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupBaselineInboundAt = 1_700_000_060
            store.telegramSetupBaselineOutboundAt = 1_700_000_090
            store.telegramSetupWaitingForDM = true
            store.telegramSetupStatus = "Waiting for Jarvis to finish your first Telegram task..."

            store.snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_060,
                outboundAt: 1_700_000_090,
                snapshotTs: 1_700_000_120,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(store.completeConsumerTelegramFirstTaskVerificationFromRecentActivityIfPossible())
            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(!store.telegramSetupWaitingForDM)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. Chat approved.")
        }
    }

    @Test func `pending pairing bootstrap completes from already observed live activity`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.telegramSetupBotId = 8_582_422_927
            store.telegramSetupBotUsername = "jarvis_consumer_smoke_2_bot"
            store.telegramSetupFirstSenderId = "42"

            let snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_060,
                outboundAt: 1_700_000_090,
                snapshotTs: 1_700_000_120,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")
            store.snapshot = snapshot

            // This is the production failure shape: the pending-pairing path
            // had already treated the successful DM/reply as its baseline, so
            // the normal "did activity advance?" check would wait forever for
            // another DM unless the recovery path deliberately accepts recent
            // paired activity that is already in the channel snapshot.
            store.telegramSetupBaselineInboundAt = 1_700_000_060
            store.telegramSetupBaselineOutboundAt = 1_700_000_090
            store.telegramSetupWaitingForDM = true

            var refreshCount = 0
            let completed = await store._testCompletePendingTelegramPairingFromExistingObservedActivityAfterBootstrap {
                refreshCount += 1
            }

            #expect(refreshCount == 1)
            #expect(completed)
            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(!store.telegramSetupWaitingForDM)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. Chat approved.")
        }
    }

    @Test func `verified allowlist config promotes missing first task marker`() async throws {
        let instanceId = "approved-config-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let defaultsKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(
                instanceId: instanceId)
            defer {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }

            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "8932460707:token",
                        "dmPolicy": "allowlist",
                        "allowFrom": ["1336356696"],
                    ],
                ],
            ]
            store.snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: nil,
                outboundAt: nil,
                botId: 8_932_460_707,
                username: "jarvis_e4851665_bot")

            #expect(!store.consumerTelegramFirstTaskVerified)
            #expect(store.completeConsumerTelegramFirstTaskVerificationFromApprovedConfigIfPossible())
            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupFirstSenderId == "1336356696")
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_e4851665_bot. Chat approved.")
        }
    }

    @Test func `verified allowlist config does not promote without sender evidence`() async throws {
        let instanceId = "approved-config-negative-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let defaultsKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(
                instanceId: instanceId)
            defer {
                UserDefaults.standard.removeObject(forKey: defaultsKey)
            }

            let store = ChannelsStore(isPreview: true)
            store.clearConsumerTelegramFirstTaskVerified()
            store.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "8932460707:token",
                        "dmPolicy": "allowlist",
                        "allowFrom": [],
                    ],
                ],
            ]
            store.snapshot = makeConsumerTelegramSnapshot(
                running: true,
                inboundAt: nil,
                outboundAt: nil,
                botId: 8_932_460_707,
                username: "jarvis_e4851665_bot")

            #expect(!store.completeConsumerTelegramFirstTaskVerificationFromApprovedConfigIfPossible())
            #expect(!store.consumerTelegramFirstTaskVerified)
        }
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

    @Test func `pending pairing replay skips setup command and keeps first real message`() throws {
        let startDM = TelegramSetupDirectMessage(
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
            messageThreadId: nil)
        let taskDM = TelegramSetupDirectMessage(
            updateId: 102,
            messageId: 203,
            chatId: 303,
            chatUsername: "jarvis_consumer_smoke_2",
            senderId: 404,
            senderUsername: "artem",
            senderFirstName: "Artem",
            text: "Wake up, my friend",
            caption: nil,
            date: 506,
            messageThreadId: nil)

        #expect(!ChannelsStore.consumerTelegramShouldReplayPendingPairingMessage(startDM))
        #expect(ChannelsStore.consumerTelegramShouldReplayPendingPairingMessage(taskDM))
    }

    @Test func `pending pairing replay synthesizes positive update id when Telegram metadata omits it`() throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-telegram-synthetic-replay-\(UUID().uuidString)", isDirectory: true)
        let credentialsDir = stateDir.appendingPathComponent("credentials", isDirectory: true)
        try FileManager.default.createDirectory(
            at: credentialsDir,
            withIntermediateDirectories: true)
        let pairingPath = credentialsDir.appendingPathComponent("telegram-pairing.json")
        let body = """
        {
          "version": 1,
          "requests": [
            {
              "id": "1336356696",
              "code": "ABC123",
              "createdAt": "2026-06-04T12:21:53Z",
              "lastSeenAt": "2026-06-04T12:21:53Z",
              "meta": {
                "chatId": "1336356696",
                "messageId": "2",
                "text": "Wake up my friend",
                "date": "1780575713"
              }
            }
          ]
        }
        """
        try body.write(to: pairingPath, atomically: true, encoding: .utf8)

        let dm = try #require(ChannelsStore._testLatestPendingTelegramPairingDirectMessage(
            now: ISO8601DateFormatter().date(from: "2026-06-04T12:22:00Z")!,
            stateDirURL: stateDir))

        #expect(dm.updateId > 0)
        #expect(dm.updateId != -1)
    }

    @Test func `managed telegram client decodes start and connected status responses`() async throws {
        let client = try JarvisTelegramManagedBotClient(
            configuration: .init(
                baseURL: #require(URL(string: "https://jarvis.example.test")),
                accessToken: "server-token",
                accountAccessToken: "jat_account_token"),
            transport: { request in
                let path = request.url?.path ?? ""
                let body: String
                if path == "/v1/telegram/managed/start" {
                    body = """
                    {
                      "setupId": "tgms_test",
                      "approvalUrl": "https://t.me/JarvisManagerBot?start=abc",
                      "suggestedBotUsername": "jarvis_test_bot",
                      "expiresAt": "2026-05-18T12:00:00Z",
                      "status": "pending"
                    }
                    """
                } else {
                    body = """
                    {
                      "setupId": "tgms_test",
                      "expiresAt": "2026-05-18T12:00:00Z",
                      "status": "connected",
                      "suggestedBotUsername": "jarvis_test_bot",
                      "botId": 777000,
                      "botUsername": "jarvis_test_bot",
                      "managedChildBotToken": "777000:test-child-token"
                    }
                    """
                }
                guard let url = request.url,
                      let response = HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: nil)
                else {
                    throw URLError(.badServerResponse)
                }
                return (
                    Data(body.utf8),
                    response)
            })

        let started = try await client.start(suggestedBotName: "Jarvis")
        let connected = try await client.status(setupId: started.setupId)

        #expect(started.setupId == "tgms_test")
        #expect(started.approvalUrl == "https://t.me/JarvisManagerBot?start=abc")
        #expect(connected.status == "connected")
        #expect(connected.managedChildBotToken == "777000:test-child-token")
    }

    @Test func `managed telegram start requires activated Jarvis account token`() async throws {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.configRoot = [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://jarvis.example.test",
                        "accessToken": "server-token",
                    ],
                ],
            ]

            await store.startManagedTelegramSetup()

            #expect(store.telegramManagedSetupId == nil)
            #expect(store.telegramSetupStatus == "Create or sign in to Jarvis before creating a managed Telegram bot.")
        }
    }

    @Test func `managed telegram setup lease restores after app relaunch`() async throws {
        let instanceId = "managed-lease-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let keys = [
                ChannelsStore.managedTelegramSetupIdDefaultsKey,
                ChannelsStore.managedTelegramApprovalURLDefaultsKey,
                ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey,
                ChannelsStore.managedTelegramExpiresAtDefaultsKey,
            ]
            let defaults = UserDefaults.standard
            keys.forEach { defaults.removeObject(forKey: $0) }
            defer { keys.forEach { defaults.removeObject(forKey: $0) } }

            let expiresAt = Date(timeIntervalSinceNow: 30 * 60)
            defaults.set("tgms_restore", forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey)
            defaults.set(
                "https://t.me/JarvisManagerBot?start=restore",
                forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey)
            defaults.set(
                "jarvis_restore_bot",
                forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey)
            defaults.set(
                expiresAt.timeIntervalSince1970,
                forKey: ChannelsStore.managedTelegramExpiresAtDefaultsKey)

            let restored = ChannelsStore(isPreview: true)

            #expect(restored.telegramManagedSetupId == "tgms_restore")
            #expect(restored.telegramManagedApprovalURL == "https://t.me/JarvisManagerBot?start=restore")
            #expect(restored.telegramManagedSuggestedBotUsername == "jarvis_restore_bot")
            #expect(restored.telegramManagedExpiresAt != nil)
            #expect(restored.telegramSetupStatus?.contains("@jarvis_restore_bot") == true)
        }
    }

    @Test func `managed telegram start reuses active restored lease instead of creating another bot`() async throws {
        let instanceId = "managed-reuse-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let keys = [
                ChannelsStore.managedTelegramSetupIdDefaultsKey,
                ChannelsStore.managedTelegramApprovalURLDefaultsKey,
                ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey,
                ChannelsStore.managedTelegramExpiresAtDefaultsKey,
            ]
            let defaults = UserDefaults.standard
            keys.forEach { defaults.removeObject(forKey: $0) }
            defer { keys.forEach { defaults.removeObject(forKey: $0) } }

            defaults.set("tgms_reuse", forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey)
            defaults.set(
                "https://t.me/JarvisManagerBot?start=reuse",
                forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey)
            defaults.set(
                "jarvis_reuse_bot",
                forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey)
            defaults.set(
                Date(timeIntervalSinceNow: 30 * 60).timeIntervalSince1970,
                forKey: ChannelsStore.managedTelegramExpiresAtDefaultsKey)

            let startCounter = ManagedTelegramRequestCounter()
            await JarvisTelegramManagedBotClient._testSetTransportOverride { request in
                if request.url?.path == "/v1/telegram/managed/start" {
                    await startCounter.recordStart()
                }
                throw URLError(.badServerResponse)
            }

            let store = ChannelsStore(isPreview: true)
            await store.startManagedTelegramSetup()

            #expect(await startCounter.value() == 0)
            #expect(store.telegramManagedSetupId == "tgms_reuse")
            #expect(store.telegramManagedSuggestedBotUsername == "jarvis_reuse_bot")
            #expect(store.telegramSetupStatus?.contains("@jarvis_reuse_bot") == true)

            await JarvisTelegramManagedBotClient._testSetTransportOverride(nil)
        }
    }

    @Test func `expired managed telegram setup lease is cleared on relaunch`() async throws {
        let instanceId = "managed-expired-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let keys = [
                ChannelsStore.managedTelegramSetupIdDefaultsKey,
                ChannelsStore.managedTelegramApprovalURLDefaultsKey,
                ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey,
                ChannelsStore.managedTelegramExpiresAtDefaultsKey,
            ]
            let defaults = UserDefaults.standard
            keys.forEach { defaults.removeObject(forKey: $0) }
            defer { keys.forEach { defaults.removeObject(forKey: $0) } }

            defaults.set("tgms_expired", forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey)
            defaults.set(
                "https://t.me/JarvisManagerBot?start=expired",
                forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey)
            defaults.set(
                "jarvis_expired_bot",
                forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey)
            defaults.set(
                Date(timeIntervalSinceNow: -60).timeIntervalSince1970,
                forKey: ChannelsStore.managedTelegramExpiresAtDefaultsKey)

            let restored = ChannelsStore(isPreview: true)

            #expect(restored.telegramManagedSetupId == nil)
            #expect(restored.telegramManagedApprovalURL == nil)
            #expect(restored.telegramManagedSuggestedBotUsername == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey) == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey) == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey) == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramExpiresAtDefaultsKey) == nil)
        }
    }

    @Test func `managed telegram setup lease without expiry is cleared on relaunch`() async throws {
        let instanceId = "managed-missing-expiry-\(UUID().uuidString)"
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: instanceId,
        ]) {
            let keys = [
                ChannelsStore.managedTelegramSetupIdDefaultsKey,
                ChannelsStore.managedTelegramApprovalURLDefaultsKey,
                ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey,
                ChannelsStore.managedTelegramExpiresAtDefaultsKey,
            ]
            let defaults = UserDefaults.standard
            keys.forEach { defaults.removeObject(forKey: $0) }
            defer { keys.forEach { defaults.removeObject(forKey: $0) } }

            defaults.set("tgms_no_expiry", forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey)
            defaults.set(
                "https://t.me/JarvisManagerBot?start=no-expiry",
                forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey)
            defaults.set(
                "jarvis_no_expiry_bot",
                forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey)

            let restored = ChannelsStore(isPreview: true)

            #expect(restored.telegramManagedSetupId == nil)
            #expect(restored.telegramManagedApprovalURL == nil)
            #expect(restored.telegramManagedSuggestedBotUsername == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramSetupIdDefaultsKey) == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramApprovalURLDefaultsKey) == nil)
            #expect(defaults.object(forKey: ChannelsStore.managedTelegramSuggestedBotUsernameDefaultsKey) == nil)
        }
    }

    @Test func `managed telegram status installs child token as enabled usable config`() async throws {
        let savedRoot = SavedConfigRoot()
        let configPath = TestIsolation.tempConfigPath()
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-managed-telegram-\(UUID().uuidString)", isDirectory: true)
            .path

        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_STATE_DIR": stateDir,
            "JARVIS_BACKEND_BASE_URL": "https://jarvis.example.test",
            "JARVIS_BACKEND_ACCESS_TOKEN": "server-token",
            "JARVIS_ACCOUNT_ACCESS_TOKEN": "jat_account_token",
        ]) {
            let initialRoot: [String: Any] = [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://jarvis.example.test",
                        "accessToken": "server-token",
                        "accountAccessToken": "jat_account_token",
                    ],
                    "managedServices": [
                        "mode": "license-only",
                        "futureFlag": true,
                    ],
                ],
                "secrets": [
                    "providers": [
                        "jarvis-keychain": [
                            "source": "exec",
                            "command": "/usr/bin/security",
                        ],
                        "other-provider": [
                            "source": "env",
                        ],
                    ],
                ],
            ]
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false },
                loadLocal: { initialRoot },
                saveLocal: { root in
                    savedRoot.set(root)
                }))
            await JarvisTelegramManagedBotClient._testSetTransportOverride { request in
                #expect(request.url?.path == "/v1/telegram/managed/status/tgms_test")
                let body = """
                {
                  "setupId": "tgms_test",
                  "expiresAt": "2026-05-18T12:00:00Z",
                  "status": "connected",
                  "suggestedBotUsername": "jarvis_test_bot",
                  "botId": 777000,
                  "botUsername": "jarvis_test_bot",
                  "managedChildBotToken": "777000:test-child-token"
                }
                """
                guard let url = request.url,
                      let response = HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: nil)
                else {
                    throw URLError(.badServerResponse)
                }
                return (
                    Data(body.utf8),
                    response)
            }

            do {
                let store = ChannelsStore(isPreview: true)
                store.configRoot = initialRoot
                store.telegramManagedSetupId = "tgms_test"

                await store.checkManagedTelegramSetupStatus()

                let telegram = try #require(
                    ((savedRoot.value()["channels"] as? [String: Any])?["telegram"] as? [String: Any]))
                let jarvis = try #require(savedRoot.value()["jarvis"] as? [String: Any])
                let backend = try #require(jarvis["backend"] as? [String: Any])
                let managedServices = try #require(jarvis["managedServices"] as? [String: Any])
                let tools = try #require(savedRoot.value()["tools"] as? [String: Any])
                let media = try #require(tools["media"] as? [String: Any])
                let audio = try #require(media["audio"] as? [String: Any])
                let audioModels = try #require(audio["models"] as? [[String: Any]])
                let secrets = try #require(savedRoot.value()["secrets"] as? [String: Any])
                let providers = try #require(secrets["providers"] as? [String: Any])
                let plugins = try #require(savedRoot.value()["plugins"] as? [String: Any])
                let accounts = try #require(telegram["accounts"] as? [String: Any])
                let defaultAccount = try #require(accounts["default"] as? [String: Any])
                let pluginEntries = try #require(plugins["entries"] as? [String: Any])
                let telegramPluginEntry = try #require(pluginEntries["telegram"] as? [String: Any])
                let firecrawlPluginEntry = try #require(pluginEntries["firecrawl"] as? [String: Any])
                let bravePluginEntry = try #require(pluginEntries["brave"] as? [String: Any])
                #expect(telegram["botToken"] as? String == "777000:test-child-token")
                #expect(defaultAccount["botToken"] as? String == "777000:test-child-token")
                #expect(telegram["enabled"] as? Bool == true)
                #expect(telegram["dmPolicy"] as? String == "pairing")
                #expect((telegram["allowFrom"] as? [String])?.isEmpty ?? true)
                #expect(plugins["allow"] as? [String] == [
                    "telegram",
                    "anthropic",
                    "openai",
                    "firecrawl",
                    "brave",
                ])
                #expect(plugins["deny"] as? [String] == ["acpx", "diffs"])
                #expect(telegramPluginEntry["enabled"] as? Bool == true)
                #expect(firecrawlPluginEntry["enabled"] as? Bool == true)
                #expect(bravePluginEntry["enabled"] as? Bool == true)
                #expect(managedServices["mode"] as? String == "managed")
                #expect(managedServices["futureFlag"] as? Bool == true)
                #expect(audio["enabled"] as? Bool == true)
                #expect(audioModels.first?["provider"] as? String == "jarvis-managed-openai")
                #expect(audioModels.first?["model"] as? String == "gpt-4o-mini-transcribe")
                #expect(backend["baseUrl"] as? String == "https://jarvis.example.test")
                #expect(backend["accountAccessToken"] == nil)
                #expect(providers["jarvis-keychain"] == nil)
                #expect((providers["other-provider"] as? [String: Any])?["source"] as? String == "env")
                #expect(store.telegramSetupStatus?.contains("777000:test-child-token") == false)

                await JarvisTelegramManagedBotClient._testSetTransportOverride(nil)
                await ConfigStore._testClearOverrides()
            } catch {
                await JarvisTelegramManagedBotClient._testSetTransportOverride(nil)
                await ConfigStore._testClearOverrides()
                throw error
            }
        }
    }

    @Test func `managed telegram setup not found clears stale verification state`() async throws {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let store = ChannelsStore(isPreview: true)
            store.telegramManagedSetupId = "tgms_missing"
            store.telegramManagedApprovalURL = "https://t.me/jarvis_managed_bot?start=tgms_missing"
            store.telegramManagedSuggestedBotUsername = "jarvis_missing_bot"
            store.telegramSetupToken = "777000:stale-child-token"
            store.telegramSetupBotId = 777000
            store.telegramSetupBotUsername = "jarvis_missing_bot"

            store._testHandleManagedTelegramSetupStatusErrorMessage("Telegram setup not found")

            #expect(store.telegramManagedSetupId == nil)
            #expect(store.telegramManagedApprovalURL == nil)
            #expect(store.telegramManagedSuggestedBotUsername == nil)
            #expect(store.telegramSetupToken.isEmpty)
            #expect(store.telegramSetupBotId == nil)
            #expect(store.telegramSetupBotUsername == nil)
            #expect(store.telegramSetupStatus?.contains("Create a new Telegram bot") == true)
        }
    }

    @Test func `managed telegram setup expired clears stale approval card state`() async throws {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let store = ChannelsStore(isPreview: true)
            store.telegramManagedSetupId = "tgms_expired"
            store.telegramManagedApprovalURL = "https://t.me/jarvis_managed_bot?start=tgms_expired"
            store.telegramManagedSuggestedBotUsername = "jarvis_expired_bot"
            store.telegramManagedExpiresAt = Date(timeIntervalSinceNow: -60)
            store.telegramSetupToken = "777000:stale-child-token"
            store.telegramSetupBotId = 777000
            store.telegramSetupBotUsername = "jarvis_expired_bot"

            store._testHandleManagedTelegramSetupStatusErrorMessage("Telegram setup expired")

            #expect(store.telegramManagedSetupId == nil)
            #expect(store.telegramManagedApprovalURL == nil)
            #expect(store.telegramManagedSuggestedBotUsername == nil)
            #expect(store.telegramManagedExpiresAt == nil)
            #expect(store.telegramSetupToken.isEmpty)
            #expect(store.telegramSetupBotId == nil)
            #expect(store.telegramSetupBotUsername == nil)
            #expect(store.telegramSetupStatus?.contains("Create a new Telegram bot") == true)
        }
    }

    @Test func `consumer setup can recover latest pending telegram pairing sender`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-telegram-pairing-\(UUID().uuidString)", isDirectory: true)
        let credentialsDir = stateDir.appendingPathComponent("credentials", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try FileManager.default.createDirectory(at: credentialsDir, withIntermediateDirectories: true)
        let pairingPath = credentialsDir.appendingPathComponent("telegram-pairing.json")
        let body = """
        {
          "version": 1,
          "requests": [
            {
              "id": "111",
              "code": "OLD111AA",
              "createdAt": "2026-05-19T13:00:00Z",
              "lastSeenAt": "2026-05-19T13:00:00Z",
              "meta": { "accountId": "default" }
            },
            {
              "id": "222",
              "code": "NEW222BB",
              "createdAt": "2026-05-19T14:00:00Z",
              "lastSeenAt": "2026-05-19T14:06:42Z",
              "meta": { "accountId": "default", "username": "artem" }
            },
            {
              "id": "333",
              "code": "OTHER333",
              "createdAt": "2026-05-19T14:10:00Z",
              "lastSeenAt": "2026-05-19T14:10:00Z",
              "meta": { "accountId": "work" }
            }
          ]
        }
        """
        try body.write(to: pairingPath, atomically: true, encoding: .utf8)

        let pending = ChannelsStore._testLatestPendingTelegramPairingRequest(
            now: try #require(ISO8601DateFormatter().date(from: "2026-05-19T14:07:00Z")),
            stateDirURL: stateDir)

        #expect(pending?.id == "222")
        #expect(pending?.meta?["username"] == "artem")
    }

    @Test func `consumer setup can recover delayed pending telegram pairing sender`() throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-telegram-delayed-pairing-\(UUID().uuidString)", isDirectory: true)
        let credentialsDir = stateDir.appendingPathComponent("credentials", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try FileManager.default.createDirectory(at: credentialsDir, withIntermediateDirectories: true)
        let pairingPath = credentialsDir.appendingPathComponent("telegram-pairing.json")
        let body = """
        {
          "version": 1,
          "requests": [
            {
              "id": "1336356696",
              "code": "WDTNXX2W",
              "createdAt": "2026-05-19T14:06:42.652Z",
              "lastSeenAt": "2026-05-19T14:06:42.652Z",
              "meta": { "accountId": "default", "username": "artemgetmann" }
            }
          ]
        }
        """
        try body.write(to: pairingPath, atomically: true, encoding: .utf8)

        let pending = ChannelsStore._testLatestPendingTelegramPairingRequest(
            now: try #require(ISO8601DateFormatter().date(from: "2026-05-19T17:30:00Z")),
            stateDirURL: stateDir)

        #expect(pending?.id == "1336356696")
        #expect(pending?.meta?["username"] == "artemgetmann")
    }

    @Test func `consumer setup can replay message metadata from pending telegram pairing`() throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-telegram-replay-pairing-\(UUID().uuidString)", isDirectory: true)
        let credentialsDir = stateDir.appendingPathComponent("credentials", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try FileManager.default.createDirectory(at: credentialsDir, withIntermediateDirectories: true)
        let pairingPath = credentialsDir.appendingPathComponent("telegram-pairing.json")
        let body = """
        {
          "version": 1,
          "requests": [
            {
              "id": "1336356696",
              "code": "WDTNXX2W",
              "createdAt": "2026-05-19T14:06:42.652Z",
              "lastSeenAt": "2026-05-19T14:06:44.652Z",
              "meta": {
                "accountId": "default",
                "username": "artemgetmann",
                "firstName": "Artem",
                "chatId": "1336356696",
                "messageId": "77",
                "text": "Wake up my friend",
                "date": "1780000000"
              }
            }
          ]
        }
        """
        try body.write(to: pairingPath, atomically: true, encoding: .utf8)

        let dm = ChannelsStore._testLatestPendingTelegramPairingDirectMessage(
            now: try #require(ISO8601DateFormatter().date(from: "2026-05-19T14:07:00Z")),
            stateDirURL: stateDir)

        #expect(dm?.senderId == 1_336_356_696)
        #expect(dm?.senderUsername == "artemgetmann")
        #expect(dm?.senderFirstName == "Artem")
        #expect(dm?.chatId == 1_336_356_696)
        #expect(dm?.messageId == 77)
        #expect(dm?.text == "Wake up my friend")
        #expect(dm?.date == 1_780_000_000)
    }
}

@MainActor
private final class SavedConfigRoot {
    private var root: [String: Any] = [:]

    func set(_ root: [String: Any]) {
        self.root = root
    }

    func value() -> [String: Any] {
        self.root
    }
}
