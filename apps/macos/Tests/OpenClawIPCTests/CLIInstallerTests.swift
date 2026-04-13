import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerTests {
    @Test func `installed location finds usable helper payload`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let cli = binDir.appendingPathComponent("openclaw")
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)

        let payload = root
            .appendingPathComponent("openclaw/lib/node_modules/openclaw/dist/entry.js")
        try fm.createDirectory(at: payload.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: payload.path, contents: Data())

        let found = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(found == cli.path)
    }

    @Test func `installed location rejects wrapper when payload is missing`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-missing-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let cli = binDir.appendingPathComponent("openclaw")
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)

        let missing = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(missing == nil)
    }

    @Test func `installed location accepts bundled consumer helper payload`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-bundled-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let cli = binDir.appendingPathComponent("openclaw")
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)

        let payload = root
            .appendingPathComponent("lib/openclaw-bundled/dist/entry.js")
        try fm.createDirectory(at: payload.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: payload.path, contents: Data())

        let found = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(found == cli.path)
    }

    @Test @MainActor func `consumer ensureInstalledIfNeeded repairs from bundled app runtime`() async throws {
        let instanceID = "cli-installer-bundled-repair"
        let fm = FileManager.default
        let homeURL = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-home-\(UUID().uuidString)",
            isDirectory: true)
        let bundleRoot = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-bundle-\(UUID().uuidString)",
            isDirectory: true)
        defer {
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: bundleRoot)
        }

        let bundle = try self.makeConsumerBundle(resourceRoot: bundleRoot)
        try self.writeBundledRuntime(into: bundle, fileManager: fm)

        let result = try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
            ])
        {
            await CLIInstaller.ensureInstalledIfNeeded(bundle: bundle, fileManager: fm)
        }

        let installLocation = ConsumerInstance(id: instanceID).installPrefixURL.appendingPathComponent("bin/openclaw").path
        switch result {
        case let .alreadyInstalled(location), let .installed(location):
            #expect(location == installLocation)
        case let .failed(message):
            Issue.record("Expected bundled repair to succeed, got: \(message)")
        }
        #expect(fm.isExecutableFile(atPath: installLocation))
        #expect(fm.isExecutableFile(atPath: ConsumerInstance(id: instanceID).installPrefixURL
            .appendingPathComponent("tools/node/bin/node").path))
    }

    @Test @MainActor func `consumer ensureInstalledIfNeeded fails bluntly when bundle runtime is missing`() async throws {
        let instanceID = "cli-installer-missing-runtime"
        let fm = FileManager.default
        let homeURL = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-missing-home-\(UUID().uuidString)",
            isDirectory: true)
        let bundleRoot = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-missing-bundle-\(UUID().uuidString)",
            isDirectory: true)
        defer {
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: bundleRoot)
        }

        let bundle = try self.makeConsumerBundle(resourceRoot: bundleRoot)

        let result = try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
            ])
        {
            await CLIInstaller.ensureInstalledIfNeeded(bundle: bundle, fileManager: fm)
        }

        switch result {
        case let .failed(message):
            #expect(message.contains("missing its bundled local runtime"))
        default:
            Issue.record("Expected bundled-runtime failure, got \(result)")
        }
    }

    private func makeConsumerBundle(resourceRoot: URL) throws -> Bundle {
        let bundleURL = resourceRoot.appendingPathComponent("CLIInstallerTests.bundle", isDirectory: true)
        let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
        let plistURL = contentsURL.appendingPathComponent("Info.plist")
        let fm = FileManager.default
        try fm.createDirectory(at: resourcesURL, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.consumer.mac.debug.tests.\(UUID().uuidString)",
            "CFBundleName": "CLIInstallerTests",
            "CFBundlePackageType": "BNDL",
            "CFBundleVersion": "1",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)

        guard let bundle = Bundle(path: bundleURL.path) else {
            throw NSError(domain: "CLIInstallerTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not load temp bundle"])
        }
        return bundle
    }

    private func writeBundledRuntime(into bundle: Bundle, fileManager: FileManager) throws {
        guard let resourceURL = bundle.resourceURL else {
            throw NSError(domain: "CLIInstallerTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Temp bundle missing resources"])
        }

        let bundledRoot = resourceURL.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/dist", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-arm64/bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-x64/bin", isDirectory: true),
            withIntermediateDirectories: true)

        let manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1")
        try JSONEncoder().encode(manifest).write(to: bundledRoot.appendingPathComponent("manifest.json"))
        try "export {}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/openclaw.mjs"),
            atomically: true,
            encoding: .utf8)
        try "{\"name\":\"openclaw\"}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/package.json"),
            atomically: true,
            encoding: .utf8)
        try "export {}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/dist/entry.js"),
            atomically: true,
            encoding: .utf8)
        try "{\"name\":\"chalk\"}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk/package.json"),
            atomically: true,
            encoding: .utf8)

        for arch in ["darwin-arm64", "darwin-x64"] {
            let nodeURL = bundledRoot.appendingPathComponent("node/\(arch)/bin/node")
            try "#!/bin/sh\necho v22.22.1\n".write(to: nodeURL, atomically: true, encoding: .utf8)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)
        }
    }
}
