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
}
