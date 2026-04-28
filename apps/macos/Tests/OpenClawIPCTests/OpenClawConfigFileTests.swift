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
        ]) {
            let path = OpenClawConfigFile.stateDirURL().path
            #expect(path.contains("Library/Application Support/OpenClaw/.openclaw"))
        }
    }

    @Test
    func `default app flavor uses simple runtime while standard keeps legacy dot dir`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": nil,
        ]) {
            #expect(AppFlavor.current == .consumer)
            #expect(AppFlavor.current.appName == "OpenClaw")
            #expect(OpenClawConfigFile.stateDirURL().path.contains("Library/Application Support/OpenClaw/.openclaw"))
        }

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "standard",
        ]) {
            #expect(AppFlavor.current == .standard)
            #expect(OpenClawConfigFile.stateDirURL().path.hasSuffix("/.openclaw"))
            #expect(!OpenClawConfigFile.stateDirURL().path.contains("Library/Application Support"))
        }
    }

    @Test
    func `consumer runtime does not copy legacy data unless migration is requested`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let legacyState = home.appendingPathComponent(".openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/OpenClaw/.openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: legacyState, withIntermediateDirectories: true)
        try #"{"source":"legacy-dotdir"}"#.write(
            to: legacyState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": nil,
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == destinationState.path)
            #expect(!FileManager().fileExists(atPath: destinationState.appendingPathComponent("openclaw.json").path))
        }
    }

    @Test
    func `consumer runtime copies legacy dotdir config when migration is requested`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let legacyState = home.appendingPathComponent(".openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/OpenClaw/.openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: legacyState, withIntermediateDirectories: true)
        try #"{"source":"legacy-dotdir"}"#.write(
            to: legacyState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": "1",
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
            #expect(migrated.contains("legacy-dotdir"))
            #expect(FileManager().fileExists(atPath: legacyState.appendingPathComponent("openclaw.json").path))
        }
    }

    @Test
    func `consumer runtime prefers legacy main dotdir over previous consumer config`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let legacyState = home.appendingPathComponent(".openclaw", isDirectory: true)
        let previousState = home
            .appendingPathComponent("Library/Application Support/OpenClaw Consumer/.openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/OpenClaw/.openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: legacyState, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: previousState, withIntermediateDirectories: true)
        try #"{"source":"legacy-main"}"#.write(
            to: legacyState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)
        try #"{"source":"previous-consumer"}"#.write(
            to: previousState.appendingPathComponent("openclaw.json"),
            atomically: true,
            encoding: .utf8)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": "1",
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
            #expect(migrated.contains("legacy-main"))
            #expect(!migrated.contains("previous-consumer"))
        }
    }

    @Test
    func `consumer runtime does not clobber existing OpenClaw config during migration`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let legacyState = home.appendingPathComponent(".openclaw", isDirectory: true)
        let destinationState = home
            .appendingPathComponent("Library/Application Support/OpenClaw/.openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        try FileManager().createDirectory(at: legacyState, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: destinationState, withIntermediateDirectories: true)
        try #"{"source":"legacy"}"#.write(
            to: legacyState.appendingPathComponent("openclaw.json"),
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
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_MIGRATE_APP_RUNTIME": "1",
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
}
