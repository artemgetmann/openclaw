import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct ConsumerRuntimeTests {
    private static let requiredWorkspaceTemplateNames = [
        "AGENTS.md",
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "GROUPS.md",
        "HEARTBEAT.md",
        "BOOTSTRAP.md",
        "MEMORY.md",
    ]

    @Test func `consumer bootstrap defaults image backend to sips`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sips")
        }
    }

    @Test func `consumer bootstrap preserves explicit image backend override`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": "sharp",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sharp")
        }
    }

    @Test func `consumer bootstrap writes main identity gateway defaults`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        try await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            let expectedState = homeURL
                .appendingPathComponent("Library/Application Support/Jarvis/.jarvis", isDirectory: true)
            #expect(OpenClawEnv.path("OPENCLAW_HOME") == expectedState.deletingLastPathComponent().path)
            #expect(OpenClawEnv.path("OPENCLAW_STATE_DIR") == expectedState.path)
            #expect(OpenClawEnv.path("OPENCLAW_CONFIG_PATH") == expectedState.appendingPathComponent("openclaw.json").path)
            let data = try Data(contentsOf: ConsumerRuntime.configURL)
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let gateway = object?["gateway"] as? [String: Any]
            #expect(gateway?["mode"] as? String == "local")
            #expect(gateway?["port"] as? Int == 18_789)
            #expect(gateway?["bind"] as? String == "loopback")
            #expect(OpenClawEnv.path("OPENCLAW_LAUNCHD_LABEL") == "ai.jarvis.gateway")
            #expect(OpenClawEnv.path("OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH") == ConsumerRuntime.configURL.path)
        }
    }

    @Test func `default consumer bootstrap rejects inherited source fork root`() async throws {
        let homeURL = try makeTempDirForTests()
        let sourceRoot = try makeTempDirForTests()
        defer {
            try? FileManager.default.removeItem(at: homeURL)
            try? FileManager.default.removeItem(at: sourceRoot)
        }

        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_HOME": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_GATEWAY_BIND": nil,
                "OPENCLAW_LOG_DIR": nil,
                "OPENCLAW_LAUNCHD_LABEL": nil,
                "OPENCLAW_FORK_ROOT": sourceRoot.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": sourceRoot.path,
            ])
        {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_FORK_ROOT") == nil)
            #expect(OpenClawEnv.path("OPENCLAW_CONFIG_PATH") == ConsumerRuntime.configURL.path)
            #expect(OpenClawEnv.path("OPENCLAW_LAUNCHD_LABEL") == "ai.jarvis.gateway")
        }
    }

    @Test func `default consumer bootstrap exports seeded bundled fork root`() async throws {
        let homeURL = try makeTempDirForTests()
        let sourceRoot = try makeTempDirForTests()
        let resourceRoot = try makeTempDirForTests()
        let bundledRoot = resourceRoot.appendingPathComponent(
            ConsumerBundledRuntime.resourceDirectoryName,
            isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: bundledRoot, withIntermediateDirectories: true)
        try self.writeBundledWorkspaceTemplates(into: bundledRoot)
        try BundledRuntimeFixtureHelper.writeMinimalBundledRuntime(
            into: bundledRoot,
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "123",
                gitCommit: "abc123",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)
        defer {
            ConsumerBundledRuntime._clearTestingResourceURL()
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: sourceRoot)
            try? fm.removeItem(at: resourceRoot)
        }

        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_HOME": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_GATEWAY_BIND": nil,
                "OPENCLAW_LOG_DIR": nil,
                "OPENCLAW_LAUNCHD_LABEL": nil,
                "OPENCLAW_FORK_ROOT": sourceRoot.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": sourceRoot.path,
            ])
        {
            ConsumerBundledRuntime._setTestingResourceURL(bundledRoot)

            ConsumerRuntime.bootstrapProcessEnvironment()

            let seededRoot = ConsumerBundledRuntime.installedProjectRoot().path
            #expect(OpenClawEnv.path("OPENCLAW_FORK_ROOT") == seededRoot)
            #expect(OpenClawEnv.path("OPENCLAW_FORK_ROOT") != sourceRoot.path)
        }
    }

    @Test func `consumer bootstrap omits canonical shared marker for isolated instances`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": "/stale/shared/openclaw.json",
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == "consumer-visible-surface-parity")
            #expect(OpenClawEnv.path("OPENCLAW_CONFIG_PATH") == ConsumerRuntime.configURL.path)
            #expect(OpenClawEnv.path("OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH") == nil)
        }
    }

    private func writeBundledWorkspaceTemplates(into bundledRoot: URL) throws {
        let templatesRoot = bundledRoot
            .appendingPathComponent("openclaw", isDirectory: true)
            .appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("reference", isDirectory: true)
            .appendingPathComponent("templates", isDirectory: true)

        try FileManager.default.createDirectory(at: templatesRoot, withIntermediateDirectories: true)
        for name in Self.requiredWorkspaceTemplateNames {
            let fileURL = templatesRoot.appendingPathComponent(name)
            try "# \(name)\n".write(to: fileURL, atomically: true, encoding: .utf8)
        }
    }
}
