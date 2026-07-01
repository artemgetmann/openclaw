import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerBundledRuntimeTests {
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
    private static let requiredTelegramUserToolingPaths = [
        "scripts/telegram-e2e/.env.example",
        "scripts/telegram-e2e/requirements.txt",
        "scripts/telegram-e2e/telethon_cli.py",
        "scripts/telegram-e2e/telethon_compat.py",
    ]

    @Test func `seeding writes bundled runtime into app prefix and is idempotent`() throws {
        let resourceRoot = try makeTempDirForTests()
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let fm = FileManager.default

        try fm.createDirectory(
            at: resourceRoot.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true),
            withIntermediateDirectories: true)
        let bundledRoot = resourceRoot.appendingPathComponent(
            ConsumerBundledRuntime.resourceDirectoryName,
            isDirectory: true)
        try self.writeBundledWorkspaceTemplates(into: bundledRoot)
        let manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1",
            uvVersion: "0.9.21")
        try BundledRuntimeFixtureHelper.writeMinimalBundledRuntime(
            into: bundledRoot,
            manifest: manifest,
            fileManager: fm)

        let seeded = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(seeded == .seeded)
        #expect(fm.isExecutableFile(atPath: installPrefix.appendingPathComponent("bin/openclaw").path))
        #expect(fm.isExecutableFile(atPath: installPrefix.appendingPathComponent("tools/node/bin/node").path))
        #expect(fm.isExecutableFile(atPath: installPrefix.appendingPathComponent("tools/uv/bin/uv").path))
        #expect(fm
            .isReadableFile(atPath: installPrefix.appendingPathComponent("lib/openclaw-bundled/dist/entry.js").path))
        #expect(fm
            .isReadableFile(atPath: installPrefix
                .appendingPathComponent("lib/openclaw-bundled/node_modules/chalk/package.json").path))
        self.assertInstalledWorkspaceTemplates(at: installPrefix, fileManager: fm)
        self.assertInstalledTelegramUserTooling(at: installPrefix, fileManager: fm)

        let ready = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(ready == .ready)

        try fm.removeItem(
            at: installPrefix
                .appendingPathComponent("lib", isDirectory: true)
                .appendingPathComponent("openclaw-bundled", isDirectory: true)
                .appendingPathComponent("scripts", isDirectory: true)
                .appendingPathComponent("telegram-e2e", isDirectory: true)
                .appendingPathComponent("telethon_cli.py"))
        let repaired = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(repaired == .seeded)
        self.assertInstalledTelegramUserTooling(at: installPrefix, fileManager: fm)
    }

    @Test func `seeding refuses to overwrite unknown CLI shim`() throws {
        let resourceRoot = try makeTempDirForTests()
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let fm = FileManager.default
        let bundledRoot = try self.writeBundledRuntimeResourceRoot(under: resourceRoot, fileManager: fm)

        let existingCLI = installPrefix.appendingPathComponent("bin/openclaw")
        try fm.createDirectory(at: existingCLI.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho user-owned-openclaw\n".write(to: existingCLI, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: existingCLI.path)

        do {
            _ = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
            Issue.record("Expected unknown CLI ownership conflict")
        } catch {
            let message = error.localizedDescription
            #expect(message.contains("does not own"))
            #expect(message.contains("explicit replace/--force"))
        }

        let preserved = try String(contentsOf: existingCLI, encoding: .utf8)
        #expect(preserved.contains("user-owned-openclaw"))
    }

    @Test func `current install check refuses unknown CLI shim even when payload is ready`() throws {
        let resourceRoot = try makeTempDirForTests()
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let fm = FileManager.default
        let bundledRoot = try self.writeBundledRuntimeResourceRoot(under: resourceRoot, fileManager: fm)

        _ = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)

        let existingCLI = installPrefix.appendingPathComponent("bin/openclaw")
        try "#!/bin/sh\necho user-owned-after-ready\n".write(to: existingCLI, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: existingCLI.path)

        do {
            _ = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
            Issue.record("Expected unknown CLI ownership conflict instead of ready")
        } catch {
            #expect(error.localizedDescription.contains("does not own"))
        }

        let preserved = try String(contentsOf: existingCLI, encoding: .utf8)
        #expect(preserved.contains("user-owned-after-ready"))
    }

    @Test func `seeding refreshes Jarvis-owned legacy CLI shim and writes ownership marker`() throws {
        let resourceRoot = try makeTempDirForTests()
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let fm = FileManager.default
        let bundledRoot = try self.writeBundledRuntimeResourceRoot(under: resourceRoot, fileManager: fm)

        let existingCLI = installPrefix.appendingPathComponent("bin/openclaw")
        try fm.createDirectory(at: existingCLI.deletingLastPathComponent(), withIntermediateDirectories: true)
        try """
        #!/bin/sh
        set -eu
        SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
        exec "$SCRIPT_DIR/../tools/node/bin/node" "$SCRIPT_DIR/../lib/openclaw-bundled/openclaw.mjs" "$@"
        """.write(to: existingCLI, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: existingCLI.path)

        let seeded = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(seeded == .seeded)

        let refreshed = try String(contentsOf: existingCLI, encoding: .utf8)
        #expect(refreshed.contains("jarvis-managed-cli-shim"))
        #expect(fm.isExecutableFile(atPath: existingCLI.path))
    }

    @Test func `seeding preserves newer installed runtime when older app bundle launches`() throws {
        let fm = FileManager.default
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let newerBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "200",
                gitCommit: "newer-runtime",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)
        let olderBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "100",
                gitCommit: "older-app",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)

        #expect(try ConsumerBundledRuntime
            .seedIfNeeded(from: newerBundle, into: installPrefix, fileManager: fm) == .seeded)
        #expect(try ConsumerBundledRuntime
            .seedIfNeeded(from: olderBundle, into: installPrefix, fileManager: fm) == .ready)
        #expect(try self.installedRuntimeManifest(at: installPrefix).gitCommit == "newer-runtime")
    }

    @Test func `older app bundle repairs incomplete newer installed runtime`() throws {
        let fm = FileManager.default
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let newerBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "200",
                gitCommit: "newer-runtime",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)
        let olderBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "100",
                gitCommit: "older-app",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)

        #expect(try ConsumerBundledRuntime
            .seedIfNeeded(from: newerBundle, into: installPrefix, fileManager: fm) == .seeded)
        try fm.removeItem(
            at: installPrefix
                .appendingPathComponent("lib", isDirectory: true)
                .appendingPathComponent("openclaw-bundled", isDirectory: true)
                .appendingPathComponent("dist", isDirectory: true)
                .appendingPathComponent("entry.js"))

        #expect(try ConsumerBundledRuntime
            .seedIfNeeded(from: olderBundle, into: installPrefix, fileManager: fm) == .seeded)
        #expect(try self.installedRuntimeManifest(at: installPrefix).gitCommit == "older-app")
        #expect(fm
            .isReadableFile(atPath: installPrefix.appendingPathComponent("lib/openclaw-bundled/dist/entry.js").path))
    }

    @Test func `compatibility protection does not block the next different app build`() throws {
        let fm = FileManager.default
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let compatibilityBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "300",
                gitCommit: "installed-app",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)
        let nextBundle = try self.writeBundledRuntimeResourceRoot(
            under: makeTempDirForTests(),
            manifest: ConsumerBundledRuntime.Manifest(
                format: 1,
                bundleVersion: "200",
                gitCommit: "next-app-build",
                nodeVersion: "22.22.1",
                uvVersion: "0.9.21"),
            fileManager: fm)

        #expect(try ConsumerBundledRuntime.seedIfNeeded(
            from: compatibilityBundle,
            into: installPrefix,
            fileManager: fm) == .seeded)
        try self.writeProtectionMarker(
            at: installPrefix,
            protectedRuntimeGitCommit: "live-hotfix",
            compatibilityManifestGitCommit: "installed-app",
            compatibilityManifestBundleVersion: "300")

        #expect(try ConsumerBundledRuntime
            .seedIfNeeded(from: nextBundle, into: installPrefix, fileManager: fm) == .seeded)
        #expect(try self.installedRuntimeManifest(at: installPrefix).gitCommit == "next-app-build")
    }

    @Test @MainActor func `bootstrap seeds bundled runtime when product bundle resources are available`() async throws {
        let instanceID = "consumer-bundled-runtime-hardening"
        let homeURL = try makeTempDirForTests()
        let bundleRoot = try makeTempDirForTests()
        let fm = FileManager.default
        let bundle = try makeTempBundle(
            resourceRoot: bundleRoot,
            bundleIdentifier: "ai.openclaw.consumer.mac.debug.bundle-seed-\(UUID().uuidString)")
        guard let bundleResourcesURL = bundle.resourceURL else {
            throw NSError(
                domain: "ConsumerBundledRuntimeTests",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Temp bundle missing resource URL"])
        }

        try fm.createDirectory(
            at: bundleResourcesURL.appendingPathComponent(
                ConsumerBundledRuntime.resourceDirectoryName,
                isDirectory: true),
            withIntermediateDirectories: true)
        let bundledRoot = bundleResourcesURL.appendingPathComponent(
            ConsumerBundledRuntime.resourceDirectoryName,
            isDirectory: true)
        try self.writeBundledWorkspaceTemplates(into: bundledRoot)

        let manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1",
            uvVersion: "0.9.21")
        try BundledRuntimeFixtureHelper.writeMinimalBundledRuntime(
            into: bundledRoot,
            manifest: manifest,
            fileManager: fm)

        defer {
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: bundleRoot)
        }

        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_HOME": nil,
                "OPENCLAW_FORK_ROOT": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_GATEWAY_BIND": nil,
                "OPENCLAW_LOG_DIR": nil,
                "OPENCLAW_LAUNCHD_LABEL": nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            ConsumerBundledRuntime.bootstrapIfNeeded(bundle: bundle, fileManager: fm)
            let seededProjectRoot = ConsumerBundledRuntime.installedProjectRoot()

            #expect(FileManager.default
                .fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("bin/openclaw").path))
            #expect(FileManager.default
                .fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("tools/node/bin/node")
                    .path))
            #expect(FileManager.default
                .fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("tools/uv/bin/uv").path))
            #expect(FileManager.default
                .fileExists(atPath: ConsumerRuntime.installPrefixURL
                    .appendingPathComponent("lib/openclaw-bundled/dist/entry.js").path))
            #expect(CommandResolver.projectRootEnvironmentHint() == seededProjectRoot.path)
            #expect(CommandResolver.daemonProjectRootEnvironmentHint() == seededProjectRoot.path)
            #expect(CommandResolver.bundledConsumerRuntimeProjectRoot()?.path == seededProjectRoot.path)
            #expect(CommandResolver.projectRootEnvironmentHint() != bundledRoot.appendingPathComponent("openclaw").path)
            self.assertInstalledWorkspaceTemplates(
                at: ConsumerRuntime.installPrefixURL,
                fileManager: FileManager.default)
            self.assertInstalledTelegramUserTooling(
                at: ConsumerRuntime.installPrefixURL,
                fileManager: FileManager.default)
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

    private func assertInstalledWorkspaceTemplates(at installPrefix: URL, fileManager: FileManager) {
        let templatesRoot = installPrefix
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent("openclaw-bundled", isDirectory: true)
            .appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("reference", isDirectory: true)
            .appendingPathComponent("templates", isDirectory: true)

        for name in Self.requiredWorkspaceTemplateNames {
            let templateURL = templatesRoot.appendingPathComponent(name)
            #expect(fileManager.fileExists(atPath: templateURL.path))
            #expect(fileManager.isReadableFile(atPath: templateURL.path))
        }
    }

    private func assertInstalledTelegramUserTooling(at installPrefix: URL, fileManager: FileManager) {
        let payloadRoot = installPrefix
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent("openclaw-bundled", isDirectory: true)

        for relativePath in Self.requiredTelegramUserToolingPaths {
            let fileURL = relativePath
                .split(separator: "/")
                .reduce(payloadRoot) { partialURL, component in
                    partialURL.appendingPathComponent(String(component))
                }
            #expect(fileManager.fileExists(atPath: fileURL.path))
            #expect(fileManager.isReadableFile(atPath: fileURL.path))
        }
    }

    private func writeBundledRuntimeResourceRoot(
        under resourceRoot: URL,
        manifest: ConsumerBundledRuntime.Manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1",
            uvVersion: "0.9.21"),
        fileManager: FileManager) throws -> URL
    {
        let bundledRoot = resourceRoot.appendingPathComponent(
            ConsumerBundledRuntime.resourceDirectoryName,
            isDirectory: true)
        try fileManager.createDirectory(at: bundledRoot, withIntermediateDirectories: true)
        try self.writeBundledWorkspaceTemplates(into: bundledRoot)
        try BundledRuntimeFixtureHelper.writeMinimalBundledRuntime(
            into: bundledRoot,
            manifest: manifest,
            fileManager: fileManager)
        return bundledRoot
    }

    private func installedRuntimeManifest(at installPrefix: URL) throws -> ConsumerBundledRuntime.Manifest {
        let manifestURL = installPrefix.appendingPathComponent(".consumer-bundled-runtime.json")
        return try JSONDecoder().decode(ConsumerBundledRuntime.Manifest.self, from: Data(contentsOf: manifestURL))
    }

    private func writeProtectionMarker(
        at installPrefix: URL,
        protectedRuntimeGitCommit: String,
        compatibilityManifestGitCommit: String,
        compatibilityManifestBundleVersion: String) throws
    {
        let marker: [String: Any] = [
            "format": 1,
            "protectedRuntimeGitCommit": protectedRuntimeGitCommit,
            "compatibilityManifestGitCommit": compatibilityManifestGitCommit,
            "compatibilityManifestBundleVersion": compatibilityManifestBundleVersion,
        ]
        let data = try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys])
        try data.write(
            to: installPrefix.appendingPathComponent(".consumer-bundled-runtime.protection.json"),
            options: .atomic)
    }

    private func makeTempBundle(resourceRoot: URL, bundleIdentifier: String) throws -> Bundle {
        let bundleURL = resourceRoot.appendingPathComponent("TempConsumerBundle.bundle", isDirectory: true)
        let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
        let plistURL = contentsURL.appendingPathComponent("Info.plist")
        let fm = FileManager.default
        try fm.createDirectory(at: resourcesURL, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": bundleIdentifier,
            "CFBundleName": "TempConsumerBundle",
            "CFBundlePackageType": "BNDL",
            "CFBundleVersion": "1",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)

        guard let bundle = Bundle(path: bundleURL.path) else {
            throw NSError(
                domain: "ConsumerBundledRuntimeTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Could not load temp bundle at \(bundleURL.path)"])
        }
        return bundle
    }
}
