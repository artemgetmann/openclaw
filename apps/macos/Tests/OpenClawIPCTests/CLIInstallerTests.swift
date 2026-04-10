import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerTests {
    @Test func `prerequisite report flags missing brew git and node`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-prereqs-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        try fm.createDirectory(at: root, withIntermediateDirectories: true)

        let report = CLIInstaller.prerequisiteReport(searchPaths: [root.path])
        #expect(report.hasBrew == false)
        #expect(report.hasGit == false)
        #expect(report.hasNode == false)
        #expect(report.missingLabels == ["Homebrew", "Git", "Node"])
        #expect(report.preflightMessage?.contains("Homebrew, Git, Node") == true)
        #expect(report.failureGuidance?.contains("Administrator account") == true)
    }

    @Test func `installed location finds executable`() throws {
        let fm = FileManager()
        let root = fm.temporaryDirectory.appendingPathComponent(
            "openclaw-cli-installer-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }

        let binDir = root.appendingPathComponent("bin")
        try fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let cli = binDir.appendingPathComponent("openclaw")
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)

        let found = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(found == cli.path)

        try fm.removeItem(at: cli)
        fm.createFile(atPath: cli.path, contents: Data())
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cli.path)

        let missing = CLIInstaller.installedLocation(
            searchPaths: [binDir.path],
            fileManager: fm)
        #expect(missing == nil)
    }

    @Test func `installer source prefers explicit consumer override`() {
        let infoDictionary = ["OpenClawConsumerInstallerSourceURL": "https://consumer.example/install-cli.sh"]
        let environment = [
            "OPENCLAW_CONSUMER_INSTALLER_URL": "https://env.example/install-cli.sh"
        ]

        let sourceURL = CLIInstaller.consumerInstallerSourceURL(
            infoDictionary: infoDictionary,
            environment: environment)
        #expect(sourceURL.absoluteString == "https://consumer.example/install-cli.sh")

        let command = CLIInstaller.installScriptCommand(
            version: "2026.4.10",
            prefix: "/tmp/openclaw-prefix",
            installerSourceURL: sourceURL)
        #expect(command.count == 3)
        #expect(command[2].contains("https://consumer.example/install-cli.sh"))
        #expect(command[2].contains("--prefix '/tmp/openclaw-prefix'"))
    }

    @Test func `installer source falls back to environment override`() {
        let sourceURL = CLIInstaller.consumerInstallerSourceURL(
            infoDictionary: [:],
            environment: ["OPENCLAW_CONSUMER_INSTALLER_URL": "https://env.example/install-cli.sh"])
        #expect(sourceURL.absoluteString == "https://env.example/install-cli.sh")
    }
}
