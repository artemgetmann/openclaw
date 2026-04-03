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
            "OPENCLAW_HOME": nil,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == dir)
            #expect(OpenClawConfigFile.url().path == "\(dir)/openclaw.json")
        }
    }

    @Test
    func `consumer flavor prefers application support state dir`() async {
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_HOME": nil,
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
            ])
        {
            let path = OpenClawConfigFile.stateDirURL().path
            #expect(path.contains("Library/Application Support/OpenClaw Consumer/.openclaw"))
        }
    }

    @Test
    func `named consumer instance prefers instance scoped application support state dir`() async {
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_HOME": nil,
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: "agent-a",
            ])
        {
            let path = OpenClawConfigFile.stateDirURL().path
            #expect(path.contains("Library/Application Support/OpenClaw Consumer/instances/agent-a/.openclaw"))
            #expect(OpenClawConfigFile.url().path.hasSuffix("/instances/agent-a/.openclaw/openclaw.json"))
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
            let meta = configRoot?["meta"] as? [String: Any]
            #expect(meta != nil)
            #expect(meta?["lastTouchedBundlePath"] as? String == Bundle.main.bundlePath)

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
            #expect(auditRoot?["bundlePath"] as? String == Bundle.main.bundlePath)
            #expect(auditRoot?["bundlePathAfter"] as? String == Bundle.main.bundlePath)
        }
    }

    @MainActor
    @Test
    func `save dict flags bundle path changes in config audit`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let auditPath = stateDir.appendingPathComponent("logs/config-audit.jsonl")

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            let initial: [String: Any] = [
                "gateway": ["mode": "local"],
                "meta": [
                    "lastTouchedAt": "2026-04-03T00:00:00Z",
                    "lastTouchedBundlePath": "/Users/test/Downloads/OpenClaw Consumer.app",
                    "lastTouchedVersion": "2026.3.14",
                ],
            ]
            let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted, .sortedKeys])
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
            try initialData.write(to: configPath, options: [.atomic])

            OpenClawConfigFile.saveDict([
                "gateway": ["mode": "local"],
            ])

            let rawAudit = try String(contentsOf: auditPath, encoding: .utf8)
            let lines = rawAudit.split(whereSeparator: \.isNewline).map(String.init)
            guard let last = lines.last else {
                Issue.record("Missing config audit line")
                return
            }
            let auditRoot = try JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any]
            let suspicious = auditRoot?["suspicious"] as? [String] ?? []
            #expect(suspicious.contains("bundle-path-changed"))
            #expect(auditRoot?["bundlePathBefore"] as? String == "/Users/test/Downloads/OpenClaw Consumer.app")
            #expect(auditRoot?["bundlePathAfter"] as? String == Bundle.main.bundlePath)
        }
    }
}
