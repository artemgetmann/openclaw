import Foundation

@MainActor
enum CLIInstaller {
    struct PrerequisiteReport: Equatable {
        let hasBrew: Bool
        let hasGit: Bool
        let hasNode: Bool

        var missingLabels: [String] {
            var labels: [String] = []
            if !self.hasBrew { labels.append("Homebrew") }
            if !self.hasGit { labels.append("Git") }
            if !self.hasNode { labels.append("Node") }
            return labels
        }

        var preflightMessage: String? {
            let missing = self.missingLabels
            guard !missing.isEmpty else { return nil }
            return """
            Missing prerequisites detected: \(missing.joined(separator: ", ")). The installer will \
            bootstrap them if your account can authorize it.
            """
        }

        var failureGuidance: String? {
            guard !self.hasBrew else { return nil }
            return """
            Homebrew is missing on this Mac. If the installer stops at the Homebrew step, you need \
            a macOS Administrator account to authorize the bootstrap.
            """
        }
    }

    static func installedLocation() -> String? {
        self.installedLocation(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: .default)
    }

    static func installedLocation(
        searchPaths: [String],
        fileManager: FileManager) -> String?
    {
        for basePath in searchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("openclaw").path
            var isDirectory: ObjCBool = false

            guard fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory),
                  !isDirectory.boolValue
            else {
                continue
            }

            guard fileManager.isExecutableFile(atPath: candidate) else { continue }

            return candidate
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func prerequisiteReport(searchPaths: [String]? = nil) -> PrerequisiteReport {
        let paths = searchPaths ?? CommandResolver.preferredPaths()
        return PrerequisiteReport(
            hasBrew: CommandResolver.findExecutable(named: "brew", searchPaths: paths) != nil,
            hasGit: CommandResolver.findExecutable(named: "git", searchPaths: paths) != nil,
            hasNode: CommandResolver.findExecutable(named: "node", searchPaths: paths) != nil)
    }

    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async {
        let expected = GatewayEnvironment.expectedGatewayVersionString() ?? "latest"
        let prefix = Self.installPrefix()
        let prerequisites = Self.prerequisiteReport()
        if let preflight = prerequisites.preflightMessage {
            await statusHandler(preflight)
        } else {
            await statusHandler("Installing openclaw CLI…")
        }
        let cmd = self.installScriptCommand(version: expected, prefix: prefix)
        let response = await ShellExecutor.runDetailed(command: cmd, cwd: nil, env: nil, timeout: 900)

        if response.success {
            let parsed = self.parseInstallEvents(response.stdout)
            let installedVersion = parsed.last { $0.event == "done" }?.version
            let summary = installedVersion.map { "Installed openclaw \($0)." } ?? "Installed openclaw."
            await statusHandler(summary)
            return
        }

        let parsed = self.parseInstallEvents(response.stdout)
        if let error = parsed.last(where: { $0.event == "error" })?.message {
            await statusHandler(Self.failureMessage(error, prerequisites: prerequisites))
            return
        }

        let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = response.errorMessage ?? "install failed"
        await statusHandler(Self.failureMessage(detail.isEmpty ? fallback : detail, prerequisites: prerequisites))
    }

    private static func installPrefix() -> String {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw")
            .path
    }

    private static func installScriptCommand(version: String, prefix: String) -> [String] {
        let escapedVersion = self.shellEscape(version)
        let escapedPrefix = self.shellEscape(prefix)
        // Consumer guardrail: this app only orchestrates bootstrap.
        // Keep the actual install source fork-controlled; do not swap this to
        // a generic upstream default without an explicit consumer-product decision.
        let script = """
        curl -fsSL https://openclaw.bot/install-cli.sh | \
        bash -s -- --json --no-onboard --prefix \(escapedPrefix) --version \(escapedVersion)
        """
        return ["/bin/bash", "-lc", script]
    }

    private static func parseInstallEvents(_ output: String) -> [InstallEvent] {
        let decoder = JSONDecoder()
        let lines = output
            .split(whereSeparator: \.isNewline)
            .map { String($0) }
        var events: [InstallEvent] = []
        for line in lines {
            guard let data = line.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(InstallEvent.self, from: data) {
                events.append(event)
            }
        }
        return events
    }

    private static func shellEscape(_ raw: String) -> String {
        "'" + raw.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    private static func failureMessage(_ detail: String, prerequisites: PrerequisiteReport) -> String {
        if let guidance = prerequisites.failureGuidance {
            return "Install failed: \(detail) \(guidance)"
        }
        return "Install failed: \(detail)"
    }
}

private struct InstallEvent: Decodable {
    let event: String
    let version: String?
    let message: String?
}
