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

    @Test func `seeded bundled runtime from packaged app can run version`() throws {
        let fm = FileManager.default
        let packagedAppBundle = try self.packagedConsumerAppBundleURL()
        let resourceRoot = packagedAppBundle.appendingPathComponent("Contents/Resources/OpenClawRuntime", isDirectory: true)
        let installPrefix = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)

        #expect(fm.fileExists(atPath: resourceRoot.path))

        let seeded = try ConsumerBundledRuntime.seedIfNeeded(from: resourceRoot, into: installPrefix, fileManager: fm)
        #expect(seeded == .seeded)
        #expect(fm.isReadableFile(atPath: installPrefix.appendingPathComponent("lib/openclaw-bundled/node_modules/chalk/package.json").path))

        let result = try runProcess(
            executableURL: installPrefix.appendingPathComponent("bin/openclaw"),
            arguments: ["--version"],
            environment: ["HOME": makeTempDirForTests().path])

        #expect(result.exitCode == 0)
        #expect(result.stdout.contains("OpenClaw"))
    }

    private func packagedConsumerAppBundleURL(filePath: StaticString = #filePath) throws -> URL {
        let fileURL = URL(fileURLWithPath: "\(filePath)")
        let repoRoot = fileURL
            .deletingLastPathComponent() // ConsumerBundledRuntimeTests.swift
            .deletingLastPathComponent() // OpenClawIPCTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // macos
            .deletingLastPathComponent() // apps
        let appBundleURL = repoRoot.appendingPathComponent("dist/OpenClaw Consumer.app", isDirectory: true)
        guard FileManager.default.fileExists(atPath: appBundleURL.path) else {
            throw NSError(
                domain: "ConsumerBundledRuntimeTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Packaged consumer app not found at \(appBundleURL.path). Run scripts/package-consumer-mac-app.sh first."])
        }
        return appBundleURL
    }

    private func runProcess(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = [:]) throws -> ProcessResult
    {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        process.environment = environment.merging(ProcessInfo.processInfo.environment) { _, new in new }
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        try process.run()
        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        return ProcessResult(
            exitCode: Int(process.terminationStatus),
            stdout: String(decoding: stdoutData, as: UTF8.self),
            stderr: String(decoding: stderrData, as: UTF8.self))
    }

    private struct ProcessResult {
        let exitCode: Int
        let stdout: String
        let stderr: String
    }
}
