import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct OpenClawConfigFileTests {
    private func makeConfigOverridePath() -> String {
        FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
    }

    @Test
    func `config path respects env override`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            #expect(OpenClawConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func `remote gateway port parses and matches host`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(OpenClawConfigFile.remoteGatewayPort() == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func `set remote gateway url preserves scheme`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            OpenClawConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = OpenClawConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @MainActor
    @Test
    func `clear remote gateway url removes only url field`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                        "token": "tok",
                    ],
                ],
            ])
            OpenClawConfigFile.clearRemoteGatewayUrl()
            let root = OpenClawConfigFile.loadDict()
            let remote = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any]) ?? [:]
            #expect((remote["url"] as? String) == nil)
            #expect((remote["token"] as? String) == "tok")
        }
    }

    @Test
    func `state dir override sets config path`() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": dir,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == dir)
            #expect(OpenClawConfigFile.url().path == "\(dir)/openclaw.json")
        }
    }

    @Test
    func `consumer flavor prefers application support state dir`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
        ]) {
            let path = OpenClawConfigFile.stateDirURL().path
            #expect(path.contains("Library/Application Support/Jarvis/.jarvis"))
        }
    }

    @Test
    func `default app flavor uses simple runtime while standard keeps legacy dot dir`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": nil,
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
        ]) {
            #expect(AppFlavor.current == .consumer)
            #expect(AppFlavor.current.appName == "Jarvis")
            #expect(OpenClawConfigFile.stateDirURL().path.contains("Library/Application Support/Jarvis/.jarvis"))
        }

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "standard",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
        ]) {
            #expect(AppFlavor.current == .standard)
            #expect(OpenClawConfigFile.stateDirURL().path.hasSuffix("/.openclaw"))
            #expect(!OpenClawConfigFile.stateDirURL().path.contains("Library/Application Support"))
        }
    }

    @Test
    func `consumer instance runtime automatically copies previous consumer config when destination is empty`() async throws {
        let instanceID = "migration-lane"
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw Consumer/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        let destinationState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try #"{"source":"previous-consumer"}"#.write(
            to: previousState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": instanceID,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            let migrated = try String(
                contentsOf: destinationState.appendingPathComponent("openclaw.json"),
                encoding: .utf8)
            #expect(migrated.contains("previous-consumer"))
        }
    }

    @Test
    func `consumer instance runtime migration can be disabled for controlled smoke lanes`() async throws {
        let instanceID = "migration-lane"
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw Consumer/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        let destinationState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try #"{"source":"previous-consumer"}"#.write(
            to: previousState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": instanceID,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": "1",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            #expect(!FileManager().fileExists(atPath: destinationState.appendingPathComponent("openclaw.json").path))
        }
    }

    @Test
    func `default Jarvis runtime does not automatically copy legacy dotdir config`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let legacyState = home.appendingPathComponent(".openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/Jarvis/.jarvis", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: legacyState, withIntermediateDirectories: true)
        try #"{"source":"legacy-dotdir"}"#.write(
            to: legacyState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)
            #expect(!FileManager().fileExists(atPath: destinationState.appendingPathComponent("openclaw.json").path))
            #expect(FileManager().fileExists(atPath: legacyState.appendingPathComponent("openclaw.json").path))
        }
    }

    @Test
    func `default Jarvis runtime does not automatically copy previous consumer config`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent("Library/Application Support/OpenClaw Consumer/.openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/Jarvis/.jarvis", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try #"{"source":"previous-consumer"}"#.write(
            to: previousState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            #expect(!FileManager().fileExists(atPath: destinationState.appendingPathComponent("openclaw.json").path))
            #expect(FileManager().fileExists(atPath: previousState.appendingPathComponent("openclaw.json").path))
        }
    }

    @Test
    func `default Jarvis runtime backfills Telegram group config from previous consumer config`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent("Library/Application Support/OpenClaw Consumer/.openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/Jarvis/.jarvis", isDirectory: true)
        let previousConfig = previousState.appendingPathComponent("openclaw.json")
        let destinationConfig = destinationState.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: destinationState, withIntermediateDirectories: true)

        try Self.writeJSON([
            "channels": [
                "telegram": [
                    "botToken": "old-bot-token",
                    "backend": ["accessToken": "old-backend-token"],
                    "groupPolicy": "allowlist",
                    "groupAllowFrom": ["319627125", "2060385474"],
                    "groups": [
                        "*": ["requireMention": false],
                    ],
                    "accounts": [
                        "default": [
                            "botToken": "old-account-token",
                            "groupPolicy": "allowlist",
                            "groupAllowFrom": ["319627125", "2060385474"],
                            "groups": [
                                "-100123": ["requireMention": true],
                            ],
                        ],
                    ],
                ],
            ],
            "gateway": [
                "path": "/old/openclaw-consumer/gateway",
            ],
        ], to: previousConfig)

        try Self.writeJSON([
            "channels": [
                "telegram": [
                    "botToken": "new-jarvis-token",
                    "groups": [:],
                    "accounts": [
                        "default": [
                            "groupAllowFrom": [],
                        ],
                    ],
                ],
            ],
            "gateway": [
                "path": "/new/jarvis/gateway",
            ],
            "jarvis": [
                "accessToken": "new-jarvis-access-token",
            ],
        ], to: destinationConfig)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)

            let root = try Self.readJSON(destinationConfig)
            let telegram = try #require((root["channels"] as? [String: Any])?["telegram"] as? [String: Any])
            let defaultAccount = try #require((telegram["accounts"] as? [String: Any])?["default"] as? [String: Any])

            #expect(telegram["groupPolicy"] as? String == "allowlist")
            #expect(telegram["groupAllowFrom"] as? [String] == ["319627125", "2060385474"])
            let groups = try #require(telegram["groups"] as? [String: Any])
            #expect((groups["*"] as? [String: Any])?["requireMention"] as? Bool == false)

            #expect(defaultAccount["groupPolicy"] as? String == "allowlist")
            #expect(defaultAccount["groupAllowFrom"] as? [String] == ["319627125", "2060385474"])
            let accountGroups = try #require(defaultAccount["groups"] as? [String: Any])
            #expect((accountGroups["-100123"] as? [String: Any])?["requireMention"] as? Bool == true)

            // Secrets and runtime paths must stay Jarvis-owned. The old
            // consumer config is only a source for group authorization/routing.
            #expect(telegram["botToken"] as? String == "new-jarvis-token")
            #expect(telegram["backend"] == nil)
            #expect(defaultAccount["botToken"] == nil)
            #expect((root["gateway"] as? [String: Any])?["path"] as? String == "/new/jarvis/gateway")
            #expect((root["jarvis"] as? [String: Any])?["accessToken"] as? String == "new-jarvis-access-token")
        }
    }

    @Test
    func `Telegram group config migration preserves existing target values`() async throws {
        let instanceID = "migration-lane"
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw Consumer/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        let destinationState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        let previousConfig = previousState.appendingPathComponent("openclaw.json")
        let destinationConfig = destinationState.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: destinationState, withIntermediateDirectories: true)

        try Self.writeJSON([
            "channels": [
                "telegram": [
                    "groupPolicy": "allowlist",
                    "groupAllowFrom": ["old-user"],
                    "groups": [
                        "*": ["requireMention": false],
                    ],
                    "accounts": [
                        "default": [
                            "groupPolicy": "allowlist",
                            "groupAllowFrom": ["old-account-user"],
                            "groups": [
                                "-100old": ["requireMention": true],
                            ],
                        ],
                    ],
                ],
            ],
        ], to: previousConfig)

        try Self.writeJSON([
            "channels": [
                "telegram": [
                    "groupPolicy": "open",
                    "groupAllowFrom": ["target-user"],
                    "groups": [
                        "-100target": ["requireMention": true],
                    ],
                    "accounts": [
                        "default": [
                            "groupPolicy": "disabled",
                            "groupAllowFrom": ["target-account-user"],
                            "groups": [
                                "-100target-account": ["requireMention": false],
                            ],
                        ],
                    ],
                ],
            ],
        ], to: destinationConfig)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": instanceID,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)

            let root = try Self.readJSON(destinationConfig)
            let telegram = try #require((root["channels"] as? [String: Any])?["telegram"] as? [String: Any])
            let defaultAccount = try #require((telegram["accounts"] as? [String: Any])?["default"] as? [String: Any])

            #expect(telegram["groupPolicy"] as? String == "open")
            #expect(telegram["groupAllowFrom"] as? [String] == ["target-user"])
            #expect((telegram["groups"] as? [String: Any])?["-100target"] != nil)
            #expect((telegram["groups"] as? [String: Any])?["*"] == nil)

            #expect(defaultAccount["groupPolicy"] as? String == "disabled")
            #expect(defaultAccount["groupAllowFrom"] as? [String] == ["target-account-user"])
            #expect((defaultAccount["groups"] as? [String: Any])?["-100target-account"] != nil)
            #expect((defaultAccount["groups"] as? [String: Any])?["-100old"] == nil)
        }
    }

    @Test
    func `consumer instance runtime does not clobber existing OpenClaw config during migration`() async throws {
        let instanceID = "migration-lane"
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let previousState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw Consumer/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        let destinationState = home
            .appendingPathComponent(
                "Library/Application Support/OpenClaw/instances/\(instanceID)/.openclaw",
                isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: destinationState, withIntermediateDirectories: true)
        try #"{"source":"legacy"}"#.write(
            to: previousState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)
        try #"{"source":"new"}"#.write(
            to: destinationState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": instanceID,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            OpenClawPaths.migrateConsumerRuntimeIfNeeded(
                identity: RuntimeIdentity.current,
                instanceID: ConsumerInstance.current.id)
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            let config = try String(
                contentsOf: destinationState.appendingPathComponent("openclaw.json"),
                encoding: .utf8)
            #expect(config.contains(#""source":"new""#))
        }
    }

    @MainActor
    @Test
    func `save dict appends config audit log`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let auditPath = stateDir.appendingPathComponent("logs/config-audit.jsonl")

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": ["mode": "local"],
            ])

            let configData = try Data(contentsOf: configPath)
            let configRoot = try JSONSerialization.jsonObject(with: configData) as? [String: Any]
            #expect((configRoot?["meta"] as? [String: Any]) != nil)

            let rawAudit = try String(contentsOf: auditPath, encoding: .utf8)
            let lines = rawAudit
                .split(whereSeparator: \.isNewline)
                .map(String.init)
            #expect(!lines.isEmpty)
            guard let last = lines.last else {
                Issue.record("Missing config audit line")
                return
            }
            let auditRoot = try JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any]
            #expect(auditRoot?["source"] as? String == "macos-openclaw-config-file")
            #expect(auditRoot?["event"] as? String == "config.write")
            #expect(auditRoot?["result"] as? String == "success")
            #expect(auditRoot?["configPath"] as? String == configPath.path)
        }
    }

    private static func writeJSON(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try FileManager().createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private static func readJSON(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
