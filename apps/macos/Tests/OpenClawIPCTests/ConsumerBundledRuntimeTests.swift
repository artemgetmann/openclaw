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

        let ready = try ConsumerBundledRuntime.seedIfNeeded(from: bundledRoot, into: installPrefix, fileManager: fm)
        #expect(ready == .ready)
    }
}
