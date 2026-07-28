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

    @Test func `mounted app never persists a login item`() {
        #expect(!LaunchAgentManager.shouldPersistLoginItem(
            requestedEnabled: true,
            bundlePath: "/Volumes/Jarvis/Jarvis.app"))
        #expect(!LaunchAgentManager.shouldPersistLoginItem(
            requestedEnabled: true,
            bundlePath: "/Volumes/Jarvis/../Jarvis/Jarvis.app"))
        #expect(LaunchAgentManager.shouldPersistLoginItem(
            requestedEnabled: true,
            bundlePath: "/Applications/Jarvis.app"))
        #expect(!LaunchAgentManager.shouldPersistLoginItem(
            requestedEnabled: false,
            bundlePath: "/Applications/Jarvis.app"))
        #expect(LaunchAgentManager.registrationUpdatePlan(
            requestedEnabled: true,
            runningBundlePath: "/Volumes/Jarvis/Jarvis.app",
            persistedBundlePath: nil,
            kind: .missing,
            legacyJobLoaded: false) == .none)
    }

    @Test func `mounted app preserves installed registration and pending migration`() throws {
        let runningBundlePath = "/Volumes/Jarvis/Jarvis.app"
        let installedBundlePath = "/Applications/Jarvis.app"
        let plist = LaunchAgentManager.renderPlist(
            bundlePath: installedBundlePath,
            environment: [:])
        let data = try #require(plist.data(using: .utf8))
        let kind = LaunchAgentManager.registrationKind(
            bundlePath: runningBundlePath,
            plistData: data)
        let persistedBundlePath = LaunchAgentManager.registrationTargetBundlePath(plistData: data)

        // The installed one-shot job is not "current" relative to the mounted
        // process, but that mismatch must never turn a DMG run into its owner.
        #expect(kind == .legacy)
        #expect(persistedBundlePath == installedBundlePath)
        #expect(LaunchAgentManager.registrationUpdatePlan(
            requestedEnabled: true,
            runningBundlePath: runningBundlePath,
            persistedBundlePath: persistedBundlePath,
            kind: kind,
            legacyJobLoaded: true,
            migrationPending: true) == .none)
    }

    @Test func `mounted app cleans normalized mounted legacy registration`() throws {
        let runningBundlePath = "/Volumes/Jarvis/Jarvis.app"
        let legacy: [String: Any] = [
            "Label": launchdLabel,
            "ProgramArguments": [
                "/Volumes/Jarvis/../Jarvis/Jarvis.app/Contents/MacOS/OpenClaw",
            ],
            "RunAtLoad": true,
            "KeepAlive": true,
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: legacy,
            format: .xml,
            options: 0)
        let kind = LaunchAgentManager.registrationKind(
            bundlePath: runningBundlePath,
            plistData: data)
        let persistedBundlePath = LaunchAgentManager.registrationTargetBundlePath(plistData: data)

        #expect(kind == .legacy)
        #expect(persistedBundlePath == runningBundlePath)
        #expect(LaunchAgentManager.registrationUpdatePlan(
            requestedEnabled: true,
            runningBundlePath: runningBundlePath,
            persistedBundlePath: persistedBundlePath,
            kind: kind,
            legacyJobLoaded: true,
            migrationPending: true) == .unloadLegacyJobAndRemove)
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
        let pendingPath = "/tmp/ai.jarvis.mac.plist.migration-pending"
        let migrationCommand = LaunchAgentManager.legacyReplacementCommand(
            migrationLabel: migrationLabel,
            migrationPendingPath: pendingPath)
        #expect(migrationCommand.executable == "/bin/launchctl")
        #expect(migrationCommand.arguments.prefix(4) == ["submit", "-l", migrationLabel, "--"])
        #expect(migrationLabel != launchdLabel)
        #expect(migrationCommand.arguments.joined(separator: " ").contains("bootout"))
        #expect(migrationCommand.arguments.joined(separator: " ").contains("bootstrap"))
        #expect(!migrationCommand.arguments.joined(separator: " ").contains("kickstart"))
        #expect(migrationCommand.arguments.contains(pendingPath))
        #expect(migrationCommand.arguments.joined(separator: " ").contains("rm -f"))
    }

    @Test func `partial migration marker retries enable and unloads disable`() {
        #expect(LaunchAgentManager.registrationUpdatePlan(
            enabled: true,
            kind: .current,
            legacyJobLoaded: false,
            migrationPending: true) == .replaceLoadedLegacyJob)
        #expect(LaunchAgentManager.registrationUpdatePlan(
            enabled: false,
            kind: .current,
            legacyJobLoaded: true,
            migrationPending: true) == .unloadLegacyJobAndRemove)
        #expect(LaunchAgentManager.registrationUpdatePlan(
            enabled: true,
            kind: .current,
            legacyJobLoaded: true,
            migrationPending: false) == .none)
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
