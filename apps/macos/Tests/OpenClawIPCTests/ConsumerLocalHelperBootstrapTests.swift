import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerLocalHelperBootstrapTests {
    @Test func `consumer local modes bootstrap helper when missing`() {
        #expect(
            ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .local,
                installedLocation: nil))
        #expect(
            ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .unconfigured,
                installedLocation: nil))
    }

    @Test func `remote or already installed lanes skip helper bootstrap`() {
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .remote,
                installedLocation: nil))
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .local,
                installedLocation: "/tmp/openclaw"))
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: false,
                connectionMode: .local,
                installedLocation: nil))
    }

    @Test func `bundled helper bootstrap repairs the consumer prefix`() async throws {
        let fm = FileManager.default
        let homeURL = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-consumer-helper-bootstrap-\(UUID().uuidString)",
            isDirectory: true)
        let bundleRoot = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-consumer-helper-bootstrap-bundle-\(UUID().uuidString)",
            isDirectory: true)
        try fm.createDirectory(at: homeURL, withIntermediateDirectories: true)
        try fm.createDirectory(at: bundleRoot, withIntermediateDirectories: true)
        defer {
            try? fm.removeItem(at: homeURL)
            try? fm.removeItem(at: bundleRoot)
        }

        let bundle = try self.makeTempConsumerBundle(resourceRoot: bundleRoot)

        try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: "helper-bootstrap-test",
                "HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
            ],
            defaults: ["gatewayPort": nil])
        {
            let result = await CLIInstaller.ensureInstalledIfNeeded(
                bundle: bundle,
                fileManager: fm)

            switch result {
            case let .alreadyInstalled(location), let .installed(location):
                #expect(fm.fileExists(atPath: location))
                #expect(location.contains(ConsumerRuntime.installPrefixURL.path))
                #expect(location.hasSuffix("bin/openclaw"))
            case let .failed(message):
                Issue.record("Expected bundled repair to succeed, got: \(message)")
            }
        }
    }

    private func makeTempConsumerBundle(resourceRoot: URL) throws -> Bundle {
        let bundleURL = resourceRoot.appendingPathComponent("TempConsumerBundle.bundle", isDirectory: true)
        let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
        let plistURL = contentsURL.appendingPathComponent("Info.plist")
        let fm = FileManager.default
        try fm.createDirectory(at: resourcesURL, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.consumer.mac.debug.bundle-bootstrap-\(UUID().uuidString)",
            "CFBundleName": "TempConsumerBundle",
            "CFBundlePackageType": "BNDL",
            "CFBundleVersion": "1",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)

        let bundledRoot = resourcesURL.appendingPathComponent(
            ConsumerBundledRuntime.resourceDirectoryName,
            isDirectory: true)
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
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)
        }

        guard let bundle = Bundle(path: bundleURL.path) else {
            throw NSError(
                domain: "ConsumerLocalHelperBootstrapTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Could not load temp bundle at \(bundleURL.path)"])
        }
        return bundle
    }
}
