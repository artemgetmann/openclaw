import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerSetupResumeTests {
    @Test func `preflight suppresses onboarding for existing usable setup`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(
                123456,
                forKey: ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey())

            let completed = ConsumerSetupResumePreflight.completeIfExistingSetupLooksUsable(
                defaults: defaults,
                root: Self.usableSetupRoot(),
                configExists: { true })

            #expect(completed)
            #expect(defaults.bool(forKey: onboardingSeenKey))
            #expect(defaults.integer(forKey: onboardingVersionKey) == currentOnboardingVersion)
        }
    }

    @Test func `preflight does not skip fresh incomplete setup`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let defaults = Self.makeDefaults()
            let completed = ConsumerSetupResumePreflight.completeIfExistingSetupLooksUsable(
                defaults: defaults,
                root: [
                    "gateway": ["mode": "local"],
                ],
                configExists: { true })

            #expect(!completed)
            #expect(!defaults.bool(forKey: onboardingSeenKey))
        }
    }

    @Test func `preflight does not suppress onboarding when telegram allowlist lacks first task marker`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)

            let completed = ConsumerSetupResumePreflight.completeIfExistingSetupLooksUsable(
                defaults: defaults,
                root: Self.usableSetupRoot(),
                configExists: { true })

            #expect(!completed)
            #expect(!defaults.bool(forKey: onboardingSeenKey))
        }
    }

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
                accountActivation: Self.activatedAccountModel(),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .blocked(.missingConfig))
        }
    }

    @Test func `incomplete permissions block before browser readiness probe`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)
            var browserProbeCalled = false

            let model = ConsumerSetupResumeModel(configExists: { true })
            let decision = await model.evaluate(
                browserSetup: BrowserSetupModel(
                    defaults: defaults,
                    detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                    loadProfiles: { [profile] },
                    verifySelectionReadiness: { _ in
                        browserProbeCalled = true
                        return nil
                    }),
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readyReadinessPayload() }),
                accountActivation: Self.activatedAccountModel(),
                channelsStore: ChannelsStore(isPreview: true),
                corePermissionsGranted: false)

            #expect(decision == .blocked(.permissions))
            #expect(!browserProbeCalled)
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
            channels.telegramSetupStatus = "Invalid Telegram token."
            channels._testApplyLoadedConfigRoot([
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "123456:abc",
                    ],
                ],
            ])
            channels.snapshot = makeResumeTelegramSnapshot(
                running: true,
                inboundAt: 1_700_000_000,
                outboundAt: 1_700_000_075,
                snapshotTs: 1_700_000_150,
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
                accountActivation: Self.activatedAccountModel(),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .complete)
            #expect(channels.consumerTelegramFirstTaskVerified)
            #expect(channels.telegramSetupStatus == "Telegram bot is live as @openclawbot. Chat approved from existing setup.")
        }
    }

    @Test func `saved browser selection does not block setup resume on readiness probe churn`() async {
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            Self.clearTelegramVerificationMarker()
            let defaults = Self.makeDefaults()
            let profile = Self.profile()
            var browserProbeCalled = false
            defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
            defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName(profile.directoryName))

            let channels = ChannelsStore(isPreview: true)
            channels.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": false,
                        "botToken": "",
                    ],
                ],
            ]

            let browserSetup = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [profile] },
                verifySelectionReadiness: { _ in
                    browserProbeCalled = true
                    return "Browser readiness failed during gateway restart."
                })
            let model = ConsumerSetupResumeModel(
                configExists: { true },
                loadTelegramState: { _ in })

            let decision = await model.evaluate(
                browserSetup: browserSetup,
                modelSetup: ConsumerModelSetupModel(
                    probeReadiness: { Self.readyReadinessPayload() },
                    listAuthOptions: {
                        ConsumerModelsAuthListPayload(options: [Self.subscriptionOptionPayload()], activeOptionId: "openai-codex-oauth")
                    },
                    listModels: { Self.curatedModelsPayload() }),
                accountActivation: Self.activatedAccountModel(),
                channelsStore: channels,
                corePermissionsGranted: true)

            #expect(decision == .blocked(.telegram))
            #expect(browserSetup.phase == .ready(profile))
            #expect(!browserProbeCalled)
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
                accountActivation: Self.activatedAccountModel(),
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
                accountActivation: Self.activatedAccountModel(),
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

    private static func activatedAccountModel() -> JarvisAccountActivationModel {
        JarvisAccountActivationModel(
            state: .activated(JarvisAccountActivationSummary(
                accountId: "acct_123",
                email: "user@example.com",
                licenseSummary: "beta")))
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

    private nonisolated static func usableSetupRoot() -> [String: Any] {
        [
            "gateway": ["mode": "local"],
            "agents": [
                "defaults": [
                    "model": [
                        "primary": "openai-codex/gpt-5.5",
                    ],
                ],
            ],
            "channels": [
                "telegram": [
                    "enabled": true,
                    "botToken": "123456:abc",
                    "allowFrom": ["42"],
                ],
            ],
        ]
    }
}

private func makeResumeTelegramSnapshot(
    running: Bool,
    inboundAt: Double?,
    outboundAt: Double?,
    snapshotTs: Double = 1_700_000_180,
    botId: Int
) -> ChannelsStatusSnapshot {
    ChannelsStatusSnapshot(
        ts: snapshotTs,
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
