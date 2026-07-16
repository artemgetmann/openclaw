import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct LaunchAgentManagerTests {
    @Test func `login agent uses one-shot background single-instance launch`() throws {
        let bundlePath = "/Applications/Jarvis & Friends.app"
        let plist = LaunchAgentManager.renderPlist(bundlePath: bundlePath, environment: [:])
        let data = try #require(plist.data(using: .utf8))
        let root = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dictionary = try #require(root as? [String: Any])

        #expect(dictionary["ProgramArguments"] as? [String] == [
            "/usr/bin/open",
            "-gja",
            bundlePath,
        ])
        #expect(dictionary["RunAtLoad"] as? Bool == true)
        #expect(dictionary["KeepAlive"] == nil)
    }

    @Test func `normal enable is durable only and never immediately launches another app`() {
        let plan = LaunchAgentManager.registrationUpdatePlan(
            enabled: true,
            kind: .missing,
            legacyJobLoaded: false)

        #expect(plan == .writeOnly)
    }

    @Test func `loaded direct executable plist is replaced as legacy`() throws {
        let bundlePath = "/Applications/Jarvis.app"
        let legacy: [String: Any] = [
            "Label": launchdLabel,
            "ProgramArguments": ["\(bundlePath)/Contents/MacOS/OpenClaw"],
            "RunAtLoad": true,
            "KeepAlive": true,
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: legacy,
            format: .xml,
            options: 0)

        #expect(LaunchAgentManager.registrationKind(bundlePath: bundlePath, plistData: data) == .legacy)
        #expect(LaunchAgentManager.registrationUpdatePlan(
            enabled: true,
            kind: .legacy,
            legacyJobLoaded: true) == .replaceLoadedLegacyJob)

        let migrationLabel = "ai.jarvis.mac.login-migration.test"
        let migrationCommand = LaunchAgentManager.legacyReplacementCommand(migrationLabel: migrationLabel)
        #expect(migrationCommand.executable == "/bin/launchctl")
        #expect(migrationCommand.arguments.prefix(4) == ["submit", "-l", migrationLabel, "--"])
        #expect(migrationLabel != launchdLabel)
        #expect(migrationCommand.arguments.joined(separator: " ").contains("bootout"))
        #expect(migrationCommand.arguments.joined(separator: " ").contains("bootstrap"))
        #expect(!migrationCommand.arguments.joined(separator: " ").contains("kickstart"))
    }

    @Test func `launch agent environment defaults image backend to sips`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_IMAGE_BACKEND": nil]) {
            let env = LaunchAgentManager.launchAgentEnvironment(base: [:])

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sips")
        }
    }

    @Test func `launch agent environment preserves explicit image backend override`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_IMAGE_BACKEND": nil]) {
            let env = LaunchAgentManager.launchAgentEnvironment(
                base: ["OPENCLAW_IMAGE_BACKEND": " sharp "])

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sharp")
        }
    }

    @MainActor
    @Test func `launch agent environment omits canonical marker for isolated consumer instances`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let env = LaunchAgentManager.launchAgentEnvironment(base: [:])

            #expect(env["OPENCLAW_CONFIG_PATH"] == ConsumerRuntime.configURL.path)
            #expect(env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] == nil)
        }
    }
}
