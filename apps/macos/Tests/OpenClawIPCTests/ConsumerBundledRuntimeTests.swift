import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerBundledRuntimeTests {
    @Test func `seeding writes bundled runtime into consumer prefix and is idempotent`() throws {
        let resourceRoot = try makeTempDirForTests()
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        let fm = FileManager.default

        try fm.createDirectory(
            at: resourceRoot.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true),
            withIntermediateDirectories: true)
        let bundledRoot = resourceRoot.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/dist", isDirectory: true),
            withIntermediateDirectories: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk", isDirectory: true),
            withIntermediateDirectories: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-arm64/bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-x64/bin", isDirectory: true),
            withIntermediateDirectories: true)

        let manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1")
        let manifestData = try JSONEncoder().encode(manifest)
        try manifestData.write(to: bundledRoot.appendingPathComponent("manifest.json"))

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
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)
        }

        let seeded = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(seeded == .seeded)
        #expect(fm.isExecutableFile(atPath: installPrefix.appendingPathComponent("bin/openclaw").path))
        #expect(fm.isExecutableFile(atPath: installPrefix.appendingPathComponent("tools/node/bin/node").path))
        #expect(fm.isReadableFile(atPath: installPrefix.appendingPathComponent("lib/openclaw-bundled/dist/entry.js").path))
        #expect(fm.isReadableFile(atPath: installPrefix.appendingPathComponent("lib/openclaw-bundled/node_modules/chalk/package.json").path))

        let ready = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(ready == .ready)
    }

    @Test @MainActor func `bootstrap seeds bundled runtime when consumer bundle resources are available`() async throws {
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
            at: bundleResourcesURL.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true),
            withIntermediateDirectories: true)
        let bundledRoot = bundleResourcesURL.appendingPathComponent(ConsumerBundledRuntime.resourceDirectoryName, isDirectory: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/dist", isDirectory: true),
            withIntermediateDirectories: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk", isDirectory: true),
            withIntermediateDirectories: true)
        try fm.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-arm64/bin", isDirectory: true),
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
        let nodeURL = bundledRoot.appendingPathComponent("node/darwin-arm64/bin/node")
        try "#!/bin/sh\necho v22.22.1\n".write(to: nodeURL, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)

        defer {
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: bundleRoot)
        }

        try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
            ],
            defaults: ["gatewayPort": nil])
        {
            ConsumerBundledRuntime.bootstrapIfNeeded(bundle: bundle, fileManager: fm)

            #expect(FileManager.default.fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("bin/openclaw").path))
            #expect(FileManager.default.fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("tools/node/bin/node").path))
            #expect(FileManager.default.fileExists(atPath: ConsumerRuntime.installPrefixURL.appendingPathComponent("lib/openclaw-bundled/dist/entry.js").path))
        }
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

        // The bundle only needs to expose the Resources directory for this test.
        return bundle
    }
}
