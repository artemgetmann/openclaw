import Foundation
import Testing
@testable import OpenClaw

private typealias SnapshotAnyCodable = OpenClaw.AnyCodable

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
            #expect(status?.contains("local Jarvis runtime is not reachable") == true)
            #expect(status?.contains("try Verify first task again") == true)
        }
    }

    @Test func `healthy telegram refresh promotes timed out setup once outbound activity proves completion`() async throws {
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
                inboundAt: 1_700_000_000,
                outboundAt: 1_700_000_060,
                botId: 8_582_422_927,
                username: "jarvis_consumer_smoke_2_bot")

            store.snapshot = snapshot
            store._testReconcileTelegramSetupProgress(with: snapshot)

            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. First task verified.")
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
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. First task verified.")
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
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_smoke_2_bot. First task verified.")
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

        let started = try await client.start(suggestedBotName: "Jarvis Assistant")
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
            #expect(telegram["dmPolicy"] as? String == "allowlist")
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
