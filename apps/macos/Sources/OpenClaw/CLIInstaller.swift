import Foundation

@MainActor
enum CLIInstaller {
    private static let missingBundledRuntimeMessage =
        "This OpenClaw Consumer build is missing its bundled local runtime. Re-download the app bundle."

    enum EnsureResult: Equatable {
        case alreadyInstalled(String)
        case installed(String)
        case failed(String)
    }

    static func installedLocation() -> String? {
        self.installedLocation(fileManager: .default)
    }

    static func installedLocation(fileManager: FileManager) -> String? {
        self.installedLocation(
            searchPaths: CommandResolver.preferredPaths(),
            fileManager: fileManager)
    }

    static func installedLocation(
        searchPaths: [String],
        fileManager: FileManager) -> String?
    {
        for basePath in searchPaths {
            let candidate = URL(fileURLWithPath: basePath).appendingPathComponent("openclaw").path
            guard self.isUsableHelper(at: candidate, fileManager: fileManager) else { continue }
            return candidate
        }

        return nil
    }

    static func isInstalled() -> Bool {
        self.installedLocation() != nil
    }

    static func ensureInstalledIfNeeded(
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void = { _ in })
        async -> EnsureResult
    {
        let installedLocation = AppFlavor.current.isConsumer
            ? self.consumerInstalledLocation(fileManager: fileManager)
            : self.installedLocation(fileManager: fileManager)
        if let location = installedLocation {
            return .alreadyInstalled(location)
        }

        if AppFlavor.current.isConsumer {
            // Consumer first-run must stay inside the signed app bundle. If the
            // helper is missing, repair it from bundled resources instead of
            // shelling out to the network installer and reintroducing brew/git.
            return await self.ensureBundledConsumerRuntime(
                bundle: bundle,
                fileManager: fileManager,
                statusHandler: statusHandler)
        }

        await self.install(statusHandler: statusHandler)

        if let location = self.installedLocation(fileManager: fileManager) {
            return .installed(location)
        }

        return .failed("OpenClaw could not install its local helper.")
    }

    static func install(statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async {
        let expected = GatewayEnvironment.preferredInstallTargetString()
        let prefix = Self.installPrefix()
        await statusHandler("Installing openclaw CLI…")
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
            await statusHandler("Install failed: \(error)")
            return
        }

        let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = response.errorMessage ?? "install failed"
        await statusHandler("Install failed: \(detail.isEmpty ? fallback : detail)")
    }

    private static func ensureBundledConsumerRuntime(
        bundle: Bundle,
        fileManager: FileManager,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void)
        async -> EnsureResult
    {
        await statusHandler("Repairing OpenClaw from the packaged app…")

        guard let resourceURL = ConsumerBundledRuntime.resourceURL(bundle: bundle) else {
            await statusHandler("Repair failed: \(self.missingBundledRuntimeMessage)")
            return .failed(self.missingBundledRuntimeMessage)
        }

        do {
            _ = try ConsumerBundledRuntime.seedIfNeeded(
                from: resourceURL,
                into: ConsumerRuntime.installPrefixURL,
                fileManager: fileManager)
        } catch {
            let message = "Bundled local runtime repair failed: \(error.localizedDescription)"
            await statusHandler("Repair failed: \(message)")
            return .failed(message)
        }

        if let location = self.consumerInstalledLocation(fileManager: fileManager) {
            await statusHandler("OpenClaw is ready on this Mac.")
            return .installed(location)
        }

        let message = "Bundled local runtime repair finished, but the local helper is still missing."
        await statusHandler("Repair failed: \(message)")
        return .failed(message)
    }

    private static func installPrefix() -> String {
        ConsumerRuntime.installPrefixURL.path
    }

    private static func consumerInstalledLocation(fileManager: FileManager) -> String? {
        self.installedLocation(
            searchPaths: [ConsumerRuntime.installPrefixURL.appendingPathComponent("bin").path],
            fileManager: fileManager)
    }

    private static func isUsableHelper(
        at path: String,
        fileManager: FileManager)
    -> Bool
    {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory),
              !isDirectory.boolValue
        else {
            return false
        }

        guard fileManager.isExecutableFile(atPath: path) else { return false }
        return self.hasHelperPayload(at: URL(fileURLWithPath: path), fileManager: fileManager)
    }

    private static func hasHelperPayload(
        at helperURL: URL,
        fileManager: FileManager)
    -> Bool
    {
        // The consumer helper is only usable when the installed wrapper and the
        // packaged Node payload both exist. A stray executable without the
        // runtime payload is the false-positive state we want to reject.
        //
        // Packaged consumer builds seed the bundled layout under
        // `lib/openclaw-bundled`, while the legacy npm install path still uses
        // `lib/node_modules/openclaw`. We accept either layout here so the
        // onboarding bootstrap can trust a valid bundled helper instead of
        // falling back to the remote installer.
        let candidates = [
            helperURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("openclaw/lib/node_modules/openclaw/dist/entry.js"),
            helperURL
                .deletingLastPathComponent()
                .appendingPathComponent("lib/node_modules/openclaw/dist/entry.js"),
            helperURL
                .appendingPathComponent("lib/node_modules/openclaw/dist/entry.js"),
            helperURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("lib/openclaw-bundled/dist/entry.js"),
            helperURL
                .deletingLastPathComponent()
                .appendingPathComponent("lib/openclaw-bundled/dist/entry.js"),
            helperURL
                .appendingPathComponent("lib/openclaw-bundled/dist/entry.js"),
        ]
        return candidates.contains { fileManager.isReadableFile(atPath: $0.path) }
    }

    private static func installScriptCommand(version: String, prefix: String) -> [String] {
        let escapedVersion = self.shellEscape(version)
        let escapedPrefix = self.shellEscape(prefix)
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
}

private struct InstallEvent: Decodable {
    let event: String
    let version: String?
    let message: String?
}
