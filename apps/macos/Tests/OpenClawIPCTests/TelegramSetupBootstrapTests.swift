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
}
