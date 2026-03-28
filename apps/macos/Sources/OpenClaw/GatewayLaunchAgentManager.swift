import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.launchd")
    #if DEBUG
    // Test-only hooks. The suite is serialized, so unsafe nonisolated storage keeps the
    // production implementation simple while still letting tests observe command selection.
    private nonisolated(unsafe) static var testLaunchAgentWriteDisabledHook: (() -> Bool)?
    private nonisolated(unsafe) static var testReadDaemonLoadedHook: (() async -> Bool?)?
    private nonisolated(unsafe) static var testRunDaemonCommandHook: ((_ args: [String], _ timeout: Double, _ quiet: Bool) async -> String?)?
    #endif

    private static var disableLaunchAgentMarkerURL: URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("disable-launchagent")
    }

    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
    }

    static func isLaunchAgentWriteDisabled() -> Bool {
        #if DEBUG
        if let hook = self.testLaunchAgentWriteDisabledHook {
            return hook()
        }
        #endif
        if FileManager().fileExists(atPath: self.disableLaunchAgentMarkerURL.path) { return true }
        return false
    }

    static func setLaunchAgentWriteDisabled(_ disabled: Bool) -> String? {
        let marker = self.disableLaunchAgentMarkerURL
        if disabled {
            do {
                try FileManager().createDirectory(
                    at: marker.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                if !FileManager().fileExists(atPath: marker.path) {
                    FileManager().createFile(atPath: marker.path, contents: nil)
                }
            } catch {
                return error.localizedDescription
            }
            return nil
        }

        if FileManager().fileExists(atPath: marker.path) {
            do {
                try FileManager().removeItem(at: marker)
            } catch {
                return error.localizedDescription
            }
        }
        return nil
    }

    static func isLoaded() async -> Bool {
        guard let loaded = await self.readDaemonLoaded() else { return false }
        return loaded
    }

    static func set(enabled: Bool, bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
        guard !CommandResolver.connectionModeIsRemote() else {
            self.logger.info("launchd change skipped (remote mode)")
            return nil
        }
        if enabled, self.isLaunchAgentWriteDisabled() {
            self.logger.info("launchd enable skipped (disable marker set)")
            return nil
        }

        if enabled {
            self.logger.info("launchd enable requested via CLI port=\(port)")
            return await self.runDaemonCommand([
                "install",
                "--force",
                "--allow-shared-service-takeover",
                "--port",
                "\(port)",
                "--runtime",
                "node",
            ])
        }

        self.logger.info("launchd disable requested via CLI")
        return await self.runDaemonCommand(["uninstall"])
    }

    static func kickstart() async {
        _ = await self.runDaemonCommand(["restart"], timeout: 20)
    }

    static func restartOrStart(bundlePath: String, port: Int) async -> String? {
        // Preserve the current shared LaunchAgent target whenever possible. A full
        // uninstall/install can silently repoint the main gateway at whichever CLI
        // binary the app resolved today, which is how an in-place restart drifts to
        // an older ~/.openclaw install and breaks plugin/runtime compatibility.
        let loaded = await self.readDaemonLoaded()
        if loaded != false {
            self.logger.info("launchd restart requested via CLI")
            let restartError = await self.runDaemonCommand(["restart"], timeout: 20, quiet: loaded == nil)
            if loaded == nil,
               let restartError,
               restartError.lowercased().contains("not loaded")
            {
                self.logger.info("launchd restart reported not loaded; falling back to install")
            } else {
                return restartError
            }
        }
        return await self.set(enabled: true, bundlePath: bundlePath, port: port)
    }

    static func launchdConfigSnapshot() -> LaunchAgentPlistSnapshot? {
        LaunchAgentPlist.snapshot(url: self.plistURL)
    }

    static func launchdGatewayLogPath() -> String {
        let snapshot = self.launchdConfigSnapshot()
        if let stdout = snapshot?.stdoutPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stdout.isEmpty
        {
            return stdout
        }
        if let stderr = snapshot?.stderrPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stderr.isEmpty
        {
            return stderr
        }
        return LogLocator.launchdGatewayLogPath
    }
}

extension GatewayLaunchAgentManager {
    #if DEBUG
    static func _setTestingHooks(
        launchAgentWriteDisabled: (() -> Bool)? = nil,
        readDaemonLoaded: (() async -> Bool?)? = nil,
        runDaemonCommand: ((_ args: [String], _ timeout: Double, _ quiet: Bool) async -> String?)? = nil)
    {
        self.testLaunchAgentWriteDisabledHook = launchAgentWriteDisabled
        self.testReadDaemonLoadedHook = readDaemonLoaded
        self.testRunDaemonCommandHook = runDaemonCommand
    }

    static func _clearTestingHooks() {
        self.testLaunchAgentWriteDisabledHook = nil
        self.testReadDaemonLoadedHook = nil
        self.testRunDaemonCommandHook = nil
    }
    #endif

    private static func readDaemonLoaded() async -> Bool? {
        #if DEBUG
        if let hook = self.testReadDaemonLoadedHook {
            return await hook()
        }
        #endif
        let result = await self.runDaemonCommandResult(
            ["status", "--json", "--no-probe"],
            timeout: 15,
            quiet: true)
        guard result.success, let payload = result.payload else { return nil }
        guard
            let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
            let service = json["service"] as? [String: Any],
            let loaded = service["loaded"] as? Bool
        else {
            return nil
        }
        return loaded
    }

    private struct CommandResult {
        let success: Bool
        let payload: Data?
        let message: String?
    }

    private struct ParsedDaemonJson {
        let text: String
        let object: [String: Any]
    }

    private static func runDaemonCommand(
        _ args: [String],
        timeout: Double = 15,
        quiet: Bool = false) async -> String?
    {
        #if DEBUG
        if let hook = self.testRunDaemonCommandHook {
            return await hook(args, timeout, quiet)
        }
        #endif
        let result = await self.runDaemonCommandResult(args, timeout: timeout, quiet: quiet)
        if result.success { return nil }
        return result.message ?? "Gateway daemon command failed"
    }

    private static func runDaemonCommandResult(
        _ args: [String],
        timeout: Double,
        quiet: Bool) async -> CommandResult
    {
        let gatewayRoot = CommandResolver.canonicalGatewayProjectRoot()
        let command = CommandResolver.openclawCommand(
            subcommand: "gateway",
            extraArgs: self.withJsonFlag(args),
            // Launchd management must always run locally, even if remote mode is configured.
            configRoot: ["gateway": ["mode": "local"]],
            projectRoot: gatewayRoot)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: timeout)
        let parsed = self.parseDaemonJson(from: response.stdout) ?? self.parseDaemonJson(from: response.stderr)
        let ok = parsed?.object["ok"] as? Bool
        let message = (parsed?.object["error"] as? String) ?? (parsed?.object["message"] as? String)
        let payload = parsed?.text.data(using: .utf8)
            ?? (response.stdout.isEmpty ? response.stderr : response.stdout).data(using: .utf8)
        let success = ok ?? response.success
        if success {
            return CommandResult(success: true, payload: payload, message: nil)
        }

        if quiet {
            return CommandResult(success: false, payload: payload, message: message)
        }

        let detail = message ?? self.summarize(response.stderr) ?? self.summarize(response.stdout)
        let exit = response.exitCode.map { "exit \($0)" } ?? (response.errorMessage ?? "failed")
        let fullMessage = detail.map { "Gateway daemon command failed (\(exit)): \($0)" }
            ?? "Gateway daemon command failed (\(exit))"
        self.logger.error("\(fullMessage, privacy: .public)")
        return CommandResult(success: false, payload: payload, message: detail)
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    private static func parseDaemonJson(from raw: String) -> ParsedDaemonJson? {
        guard let parsed = JSONObjectExtractionSupport.extract(from: raw) else { return nil }
        return ParsedDaemonJson(text: parsed.text, object: parsed.object)
    }

    private static func summarize(_ text: String) -> String? {
        TextSummarySupport.summarizeLastLine(text)
    }
}
