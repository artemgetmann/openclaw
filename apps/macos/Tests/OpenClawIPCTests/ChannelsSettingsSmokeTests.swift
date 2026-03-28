import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw

private typealias SnapshotAnyCodable = OpenClaw.AnyCodable

private let channelOrder = ["whatsapp", "telegram", "signal", "imessage"]
private let channelLabels = [
    "whatsapp": "WhatsApp",
    "telegram": "Telegram",
    "signal": "Signal",
    "imessage": "iMessage",
]
private let channelDefaultAccountId = [
    "whatsapp": "default",
    "telegram": "default",
    "signal": "default",
    "imessage": "default",
]

@MainActor
private func makeChannelsStore(
    channels: [String: SnapshotAnyCodable],
    ts: Double = 1_700_000_000_000) -> ChannelsStore
{
    let store = ChannelsStore(isPreview: true)
    store.snapshot = ChannelsStatusSnapshot(
        ts: ts,
        channelOrder: channelOrder,
        channelLabels: channelLabels,
        channelDetailLabels: nil,
        channelSystemImages: nil,
        channelMeta: nil,
        channels: channels,
        channelAccounts: [:],
        channelDefaultAccountId: channelDefaultAccountId)
    return store
}

@Suite(.serialized)
@MainActor
struct ChannelsSettingsSmokeTests {
    @Test func `channels settings builds body with snapshot`() {
        let store = makeChannelsStore(
            channels: [
                "whatsapp": SnapshotAnyCodable([
                    "configured": true,
                    "linked": true,
                    "authAgeMs": 86_400_000,
                    "self": ["e164": "+15551234567"],
                    "running": true,
                    "connected": false,
                    "lastConnectedAt": 1_700_000_000_000,
                    "lastDisconnect": [
                        "at": 1_700_000_050_000,
                        "status": 401,
                        "error": "logged out",
                        "loggedOut": true,
                    ],
                    "reconnectAttempts": 2,
                    "lastMessageAt": 1_700_000_060_000,
                    "lastEventAt": 1_700_000_060_000,
                    "lastError": "needs login",
                ]),
                "telegram": SnapshotAnyCodable([
                    "configured": true,
                    "tokenSource": "env",
                    "running": true,
                    "mode": "polling",
                    "lastStartAt": 1_700_000_000_000,
                    "probe": [
                        "ok": true,
                        "status": 200,
                        "elapsedMs": 120,
                        "bot": ["id": 123, "username": "openclawbot"],
                        "webhook": ["url": "https://example.com/hook", "hasCustomCert": false],
                    ],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
                "signal": SnapshotAnyCodable([
                    "configured": true,
                    "baseUrl": "http://127.0.0.1:8080",
                    "running": true,
                    "lastStartAt": 1_700_000_000_000,
                    "probe": [
                        "ok": true,
                        "status": 200,
                        "elapsedMs": 140,
                        "version": "0.12.4",
                    ],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
                "imessage": SnapshotAnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
            ])

        store.whatsappLoginMessage = "Scan QR"
        store.whatsappLoginQrDataUrl =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ay7pS8AAAAASUVORK5CYII="

        let view = ChannelsSettings(store: store)
        _ = view.body
    }

    @Test func `channels settings builds body without snapshot`() {
        let store = makeChannelsStore(
            channels: [
                "whatsapp": SnapshotAnyCodable([
                    "configured": false,
                    "linked": false,
                    "running": false,
                    "connected": false,
                    "reconnectAttempts": 0,
                ]),
                "telegram": SnapshotAnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "bot missing",
                    "probe": [
                        "ok": false,
                        "status": 403,
                        "error": "unauthorized",
                        "elapsedMs": 120,
                    ],
                    "lastProbeAt": 1_700_000_100_000,
                ]),
                "signal": SnapshotAnyCodable([
                    "configured": false,
                    "baseUrl": "http://127.0.0.1:8080",
                    "running": false,
                    "lastError": "not configured",
                    "probe": [
                        "ok": false,
                        "status": 404,
                        "error": "unreachable",
                        "elapsedMs": 200,
                    ],
                    "lastProbeAt": 1_700_000_200_000,
                ]),
                "imessage": SnapshotAnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "cliPath": "imsg",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_200_000,
                ]),
            ])

        let view = ChannelsSettings(store: store)
        _ = view.body
    }

    @Test func `consumer ordered channels falls back when snapshot order is empty`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: [],
                channelLabels: [:],
                channelDetailLabels: nil,
                channelSystemImages: nil,
                channelMeta: nil,
                channels: [
                    "telegram": SnapshotAnyCodable([
                        "configured": false,
                        "running": false,
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: [:])

            let view = ChannelsSettings(store: store)
            #expect(view.orderedChannels.first?.id == "telegram")
            #expect(!view.orderedChannels.isEmpty)
        }
    }

    @Test func `consumer telegram fallback stays configured when snapshot is missing`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let verificationKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(instanceId: nil)
            UserDefaults.standard.set(123456, forKey: verificationKey)
            defer { UserDefaults.standard.removeObject(forKey: verificationKey) }

            let store = ChannelsStore(isPreview: true)
            store.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "123456:test-token",
                        "dmPolicy": "allowlist",
                        "allowFrom": ["42"],
                    ],
                ],
            ]

            let view = ChannelsSettings(store: store)
            let telegram = try #require(view.orderedChannels.first)
            #expect(telegram.id == "telegram")
            #expect(view.channelEnabled(telegram))
            #expect(view.telegramSummary == "Live")
            #expect(view.telegramDetails == nil)
        }
    }

    @Test func `consumer telegram live without verified task stays in verify-first-task state`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let verificationKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(instanceId: nil)
            UserDefaults.standard.removeObject(forKey: verificationKey)

            let store = ChannelsStore(isPreview: true)
            store.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "123456:test-token",
                        "dmPolicy": "allowlist",
                        "allowFrom": ["42"],
                    ],
                ],
            ]

            let view = ChannelsSettings(store: store)
            #expect(view.telegramSummary == "Verify first task")
        }
    }

    @Test func `consumer telegram live section builds when telegram is already running`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let verificationKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(instanceId: nil)
            UserDefaults.standard.set(123, forKey: verificationKey)
            defer { UserDefaults.standard.removeObject(forKey: verificationKey) }

            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["telegram"],
                channelLabels: ["telegram": "Telegram"],
                channelDetailLabels: nil,
                channelSystemImages: nil,
                channelMeta: nil,
                channels: [
                    "telegram": SnapshotAnyCodable([
                        "configured": true,
                        "tokenSource": "config",
                        "running": true,
                        "mode": "polling",
                        "probe": [
                            "ok": true,
                            "status": 200,
                            "bot": ["id": 123, "username": "jarvis_consumer_bot"],
                        ],
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: ["telegram": "default"])
            store.telegramSetupStatus = "Saving Telegram setup..."
            store.telegramSetupPhase = .idle

            let view = ChannelsSettings(store: store)
            let telegram = try #require(view.orderedChannels.first)
            _ = view.channelSection(telegram)
            #expect(view.telegramSummary == "Live")
        }
    }

    @Test func `consumer telegram live section wins even if setup phase is stale`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let verificationKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(instanceId: nil)
            UserDefaults.standard.set(123, forKey: verificationKey)
            defer { UserDefaults.standard.removeObject(forKey: verificationKey) }

            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["telegram"],
                channelLabels: ["telegram": "Telegram"],
                channelDetailLabels: nil,
                channelSystemImages: nil,
                channelMeta: nil,
                channels: [
                    "telegram": SnapshotAnyCodable([
                        "configured": true,
                        "tokenSource": "config",
                        "running": true,
                        "mode": "polling",
                        "probe": [
                            "ok": true,
                            "status": 200,
                            "bot": ["id": 123, "username": "jarvis_consumer_bot"],
                        ],
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: ["telegram": "default"])
            store.telegramSetupStatus = "Saving Telegram setup..."
            store.telegramSetupPhase = .savingSetup
            store.telegramSetupWaitingForDM = true

            let view = ChannelsSettings(store: store)
            let telegram = try #require(view.orderedChannels.first)
            _ = view.channelSection(telegram)
            #expect(view.telegramSummary == "Live")
        }
    }

    @Test func `consumer telegram conflict gets plain language summary and details`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["telegram"],
                channelLabels: ["telegram": "Telegram"],
                channelDetailLabels: nil,
                channelSystemImages: nil,
                channelMeta: nil,
                channels: [
                    "telegram": SnapshotAnyCodable([
                        "configured": false,
                        "running": false,
                        "lastError": "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: ["telegram": "default"])

            let view = ChannelsSettings(store: store)
            #expect(view.telegramSummary == "Busy elsewhere")
            #expect(
                view.telegramDetails
                    == "This bot is already active in another OpenClaw window or worktree on this Mac. Close the other runtime or use a different bot token here.")
        }
    }

    @Test func `consumer telegram verification can use recent inbound activity`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
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
                            lastInboundAt: 200,
                            lastOutboundAt: nil,
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

            store.telegramSetupBaselineInboundAt = 150
            #expect(store.consumerTelegramCanVerifyFirstTaskFromActivity())
        }
    }

    @Test func `consumer telegram verification can use recent outbound activity`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
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
                            lastInboundAt: 200,
                            lastOutboundAt: 300,
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

            store.telegramSetupBaselineInboundAt = 250
            #expect(store.consumerTelegramCanVerifyFirstTaskFromActivity())
        }
    }

    @Test func `consumer telegram baseline primes from latest activity once`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let store = ChannelsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
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
                            lastInboundAt: 123,
                            lastOutboundAt: 150,
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

            store.primeConsumerTelegramFirstTaskBaselineIfNeeded()
            #expect(store.telegramSetupBaselineInboundAt == 150)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_100_000,
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
                            lastInboundAt: 456,
                            lastOutboundAt: 500,
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
            store.primeConsumerTelegramFirstTaskBaselineIfNeeded()
            #expect(store.telegramSetupBaselineInboundAt == 150)
        }
    }

    @Test func `consumer telegram activity verification marks ready without another DM`() async throws {
        try await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let verificationKey = ChannelsStore.consumerTelegramFirstTaskVerificationDefaultsKey(instanceId: nil)
            UserDefaults.standard.removeObject(forKey: verificationKey)

            let store = ChannelsStore(isPreview: true)
            store.configDraft = [
                "channels": [
                    "telegram": [
                        "enabled": true,
                        "botToken": "123:test-token",
                        "dmPolicy": "allowlist",
                        "allowFrom": ["42"],
                    ],
                ],
            ]
            store.snapshot = ChannelsStatusSnapshot(
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
                        "probe": [
                            "ok": true,
                            "status": 200,
                            "bot": ["id": 123, "username": "jarvis_consumer_bot"],
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
                            running: true,
                            connected: nil,
                            reconnectAttempts: nil,
                            lastConnectedAt: nil,
                            lastError: nil,
                            lastStartAt: nil,
                            lastStopAt: nil,
                            lastInboundAt: 200,
                            lastOutboundAt: 300,
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
            store.telegramSetupBaselineInboundAt = 250
            store.telegramSetupWaitingForDM = true
            store.telegramSetupPhase = .capturingFirstMessage

            #expect(store.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible())
            #expect(store.consumerTelegramFirstTaskVerified)
            #expect(store.telegramSetupFirstSenderId == "42")
            #expect(store.telegramSetupWaitingForDM == false)
            #expect(store.telegramSetupPhase == .idle)
            #expect(store.telegramSetupStatus == "Telegram bot is live as @jarvis_consumer_bot. First task verified.")
        }
    }
}
