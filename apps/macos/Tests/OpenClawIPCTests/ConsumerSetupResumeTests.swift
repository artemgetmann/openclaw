import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerSetupResumeTests {
    @Test func `fresh install does not auto skip setup`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let model = ConsumerSetupResumeModel(configExists: { false })
            let channels = ChannelsStore(isPreview: true)
            channels.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": false,
                        "botToken": "",
                    ],
                ],
            ]

            let decision = await model.evaluate(
                browserSetup: BrowserSetupModel(
                    detectChromeExecutable: { nil },
                    loadProfiles: { [] }),
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readyReadinessPayload() }),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .blocked(.missingConfig))
        }
    }

    @Test func `existing healthy setup auto completes and promotes telegram marker`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            Self.clearTelegramVerificationMarker()
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)

            let channels = ChannelsStore(isPreview: true)
            channels._testApplyLoadedConfigRoot([
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "123456:abc",
                        "allowFrom": ["42"],
                    ],
                ],
            ])
            channels.snapshot = makeResumeTelegramSnapshot(
                running: true,
                inboundAt: 1_000,
                outboundAt: 1_500,
                botId: 123456)

            let model = ConsumerSetupResumeModel(
                configExists: { true },
                loadTelegramState: { _ in })
            let decision = await model.evaluate(
                browserSetup: BrowserSetupModel(
                    defaults: defaults,
                    detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                    loadProfiles: { [profile] },
                    verifySelectionReadiness: { _ in nil }),
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readyReadinessPayload() },
                    listAuthOptions: {
                        ConsumerModelsAuthListPayload(options: [Self.subscriptionOptionPayload()], activeOptionId: "openai-codex-oauth")
                    },
                    listModels: { Self.curatedModelsPayload() }),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .complete)
            #expect(channels.consumerTelegramFirstTaskVerified)
        }
    }

    @Test func `broken model blocks only after healthy browser and permissions`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            Self.clearTelegramVerificationMarker()
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)

            let channels = ChannelsStore(isPreview: true)
            channels.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": false,
                        "botToken": "",
                    ],
                ],
            ]

            let model = ConsumerSetupResumeModel(
                configExists: { true },
                loadTelegramState: { _ in })
            let decision = await model.evaluate(
                browserSetup: BrowserSetupModel(
                    defaults: defaults,
                    detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                    loadProfiles: { [profile] },
                    verifySelectionReadiness: { _ in nil }),
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readinessFailedPayload() }),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .blocked(.model))
        }
    }

    @Test func `broken telegram blocks after browser model and permissions pass`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            Self.clearTelegramVerificationMarker()
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)

            let channels = ChannelsStore(isPreview: true)
            channels.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": false,
                        "botToken": "",
                    ],
                ],
            ]

            let model = ConsumerSetupResumeModel(
                configExists: { true },
                loadTelegramState: { _ in })
            let decision = await model.evaluate(
                browserSetup: BrowserSetupModel(
                    defaults: defaults,
                    detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                    loadProfiles: { [profile] },
                    verifySelectionReadiness: { _ in nil }),
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readyReadinessPayload() },
                    listAuthOptions: {
                        ConsumerModelsAuthListPayload(options: [Self.subscriptionOptionPayload()], activeOptionId: "openai-codex-oauth")
                    },
                    listModels: { Self.curatedModelsPayload() }),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .blocked(.telegram))
        }
    }

    private static func makeDefaults() -> UserDefaults {
        let suiteName = "ConsumerSetupResumeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private static func profile() -> ChromeProfileCandidate {
        ChromeProfileCandidate(
            directoryName: "Default",
            displayName: "Personal",
            subtitle: "user@example.com",
            lastUsedAt: nil,
            isDefaultProfile: true)
    }

    private static func clearTelegramVerificationMarker() {
        UserDefaults.standard.removeObject(
            forKey: ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey())
    }

    private nonisolated static func readyReadinessPayload() -> ConsumerModelsReadinessPayload {
        ConsumerModelsReadinessPayload(
            status: "ready",
            defaultModel: "openai-codex/gpt-5.5",
            summary: "OpenClaw-managed AI passed a live readiness check for the default model.",
            reasonCodes: [])
    }

    private nonisolated static func readinessFailedPayload() -> ConsumerModelsReadinessPayload {
        ConsumerModelsReadinessPayload(
            status: "blocked",
            defaultModel: "openai-codex/gpt-5.5",
            summary: "OpenClaw-managed AI did not answer the readiness probe in time.",
            reasonCodes: ["probe_timeout"])
    }

    private nonisolated static func subscriptionOptionPayload() -> ConsumerModelsAuthOptionPayload {
        ConsumerModelsAuthOptionPayload(
            id: "openai-codex-oauth",
            providerId: "openai-codex",
            providerLabel: "ChatGPT / Codex",
            title: "Continue with ChatGPT",
            detail: "Use your ChatGPT subscription.",
            inputKind: .none,
            submitLabel: "Continue",
            inputLabel: nil,
            inputHelp: nil,
            inputPlaceholder: nil,
            methodKind: "oauth")
    }

    private nonisolated static func curatedModelsPayload() -> ConsumerModelsModelListPayload {
        ConsumerModelsModelListPayload(
            currentModel: "openai-codex/gpt-5.5",
            options: [
                .init(id: "openai-codex/gpt-5.5", title: "GPT-5.5", detail: "Primary ChatGPT / Codex path."),
            ])
    }
}

private func makeResumeTelegramSnapshot(
    running: Bool,
    inboundAt: Double,
    outboundAt: Double,
    botId: Int
) -> ChannelsStatusSnapshot {
    ChannelsStatusSnapshot(
        ts: 1_700_000_000_000,
        channelOrder: ["telegram"],
        channelLabels: ["telegram": "Telegram"],
        channelDetailLabels: nil,
        channelSystemImages: nil,
        channelMeta: nil,
        channels: [
            "telegram": OpenClaw.AnyCodable([
                "configured": true,
                "running": running,
                "mode": "polling",
                "probe": [
                    "ok": true,
                    "status": 200,
                    "bot": ["id": botId, "username": "openclawbot"],
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
