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

    struct EntrypointOwnership: Equatable {
        let expectedEntrypoint: String?
        let actualEntrypoint: String?

        var matchesCurrentEntrypoint: Bool {
            guard let expectedEntrypoint else { return false }
            return self.actualEntrypoint == expectedEntrypoint
        }
    }

    enum DesiredAction: Equatable {
        case install
        case start
        case restart
        case stop
        case uninstall
    }

    private static var disableLaunchAgentMarkerURL: URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("disable-launchagent")
    }

    private static var plistURL: URL {
        ConsumerRuntime.gatewayLaunchAgentPlistURL
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
            let action = await self.desiredEnableAction()
            self.logger.info("launchd enable requested action=\(String(describing: action), privacy: .public) port=\(port)")
            switch action {
            case .restart:
                if let error = await self.runServiceBringupCommand(["restart"], timeout: 20) {
                    self.logger.warning("launchd restart failed; falling back to install: \(error, privacy: .public)")
                } else {
                    return nil
                }
            case .start:
                if let error = await self.runServiceBringupCommand(["start"], timeout: 20) {
                    self.logger.warning("launchd start failed; falling back to install: \(error, privacy: .public)")
                } else {
                    return nil
                }
            case .install, .stop, .uninstall:
                break
            }

            return await self.install(port: port)
        }

        self.logger.info("launchd stop requested via CLI")
        return await self.runDaemonCommand(["stop"], timeout: 20)
    }

    static func kickstart() async {
        _ = await self.runDaemonCommand(["restart"], timeout: 20)
    }

    static func uninstall() async -> String? {
        self.logger.info("launchd uninstall requested via CLI")
        return await self.runDaemonCommand(["uninstall"], timeout: 20)
    }

    static func restartOrStart(bundlePath: String, port: Int) async -> String? {
        _ = bundlePath
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

    static func currentEntrypointOwnership(snapshot: LaunchAgentPlistSnapshot? = nil) -> EntrypointOwnership {
        let resolvedSnapshot = snapshot ?? self.launchdConfigSnapshot()
        let expectedEntrypoint = CommandResolver.projectRootEnvironmentHint().flatMap { expectedRoot in
            CommandResolver.gatewayEntrypoint(in: URL(fileURLWithPath: expectedRoot, isDirectory: true))
        }
        let actualEntrypoint = self.resolveLaunchAgentEntrypoint(from: resolvedSnapshot)
        return EntrypointOwnership(
            expectedEntrypoint: expectedEntrypoint,
            actualEntrypoint: actualEntrypoint)
    }

    static func runtimeOwnershipBlockerMessage(snapshot: LaunchAgentPlistSnapshot? = nil) -> String? {
        let ownership = self.currentEntrypointOwnership(snapshot: snapshot)
        guard let expectedEntrypoint = ownership.expectedEntrypoint else { return nil }
        guard let actualEntrypoint = ownership.actualEntrypoint else { return nil }
        guard ownership.matchesCurrentEntrypoint == false else { return nil }
        return """
        Telegram live testing is blocked because this app expects \(expectedEntrypoint), but the consumer gateway is pinned to \(actualEntrypoint). Restart the consumer gateway from this build before capturing the first DM.
        """
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

    private static func desiredEnableAction() async -> DesiredAction {
        let loaded = await self.readDaemonLoaded()
        let snapshot = self.launchdConfigSnapshot()
        let launchAgentMatchesCurrentEntrypoint = self.launchAgentMatchesCurrentEntrypoint(snapshot: snapshot)
        let action = self.computeDesiredEnableAction(
            loaded: loaded,
            hasPlist: snapshot != nil,
            launchAgentMatchesCurrentEntrypoint: launchAgentMatchesCurrentEntrypoint)
        switch action {
        case .restart:
            // If the service is already registered and loaded, reinstalling it is needlessly
            // destructive: launchd will terminate the running gateway and we briefly lose the
            // listener on 19001. Prefer an in-place restart.
            return .restart
        case .start:
            // A plist already exists under the consumer label. Try a normal start first so we
            // re-use the registered service instead of churning install/uninstall state.
            return .start
        case .install, .stop, .uninstall:
            return .install
        }
    }

    private static func install(port: Int) async -> String? {
        self.logger.info("launchd install requested via CLI port=\(port)")
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

    private static func launchAgentMatchesCurrentEntrypoint(snapshot: LaunchAgentPlistSnapshot?) -> Bool {
        let ownership = self.currentEntrypointOwnership(snapshot: snapshot)
        return ownership.matchesCurrentEntrypoint
    }

    private static func resolveLaunchAgentEntrypoint(from snapshot: LaunchAgentPlistSnapshot?) -> String? {
        snapshot?.programArguments.first(where: { arg in
            arg.hasSuffix("/dist/index.js") || arg.hasSuffix("/openclaw.mjs") || arg.hasSuffix("/bin/openclaw.js")
        })
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
        let env = self.daemonCommandEnvironment(
            base: ProcessInfo.processInfo.environment,
            projectRootHint: CommandResolver.projectRootEnvironmentHint())
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

    private static func runServiceBringupCommand(
        _ args: [String],
        timeout: Double) async -> String?
    {
        let result = await self.runDaemonCommandResult(args, timeout: timeout, quiet: true)
        guard result.success else { return result.message ?? "Gateway daemon command failed" }
        guard self.shouldTreatBringupResultAsReady(result.payload) else {
            return self.bringupNotReadyMessage(from: result.payload) ?? "Gateway service is still not loaded"
        }
        return nil
    }

    static func daemonCommandEnvironment(
        base: [String: String],
        projectRootHint: String?) -> [String: String]
    {
        let instance = ConsumerInstance.current
        var env = base
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        env["OPENCLAW_PROFILE"] = instance.profile
        env["OPENCLAW_HOME"] = instance.runtimeRootURL.path
        env["OPENCLAW_STATE_DIR"] = instance.stateDirURL.path
        env["OPENCLAW_CONFIG_PATH"] = instance.configURL.path
        env["OPENCLAW_GATEWAY_PORT"] = "\(instance.gatewayPort)"
        env["OPENCLAW_GATEWAY_BIND"] = instance.gatewayBind
        env["OPENCLAW_LOG_DIR"] = instance.logsDirURL.path
        env["OPENCLAW_CONSUMER_MINIMAL_STARTUP"] = "1"
        if let id = instance.id {
            env[ConsumerInstance.envKey] = id
        } else {
            env.removeValue(forKey: ConsumerInstance.envKey)
        }
        // Keep every child CLI command pinned to the dedicated consumer gateway lane.
        // The app and gateway intentionally use different launchd labels, and the explicit
        // env keeps status/install/restart commands from drifting across authorities.
        env["OPENCLAW_LAUNCHD_LABEL"] = instance.gatewayLaunchdLabel
        if let projectRootHint, !projectRootHint.isEmpty {
            env["OPENCLAW_FORK_ROOT"] = projectRootHint
        }
        return env
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    // Keep the decision logic in a non-DEBUG helper so release packaging can reuse the
    // same branch selection that tests assert against.
    private static func computeDesiredEnableAction(
        loaded: Bool?,
        hasPlist: Bool,
        launchAgentMatchesCurrentEntrypoint: Bool = true) -> DesiredAction
    {
        if hasPlist, !launchAgentMatchesCurrentEntrypoint { return .install }
        if loaded == true { return .restart }
        if hasPlist { return .start }
        return .install
    }

    private static func parseDaemonJson(from raw: String) -> ParsedDaemonJson? {
        guard let parsed = JSONObjectExtractionSupport.extract(from: raw) else { return nil }
        return ParsedDaemonJson(text: parsed.text, object: parsed.object)
    }

    private static func shouldTreatBringupResultAsReady(_ payload: Data?) -> Bool {
        guard let object = self.parseDaemonObject(payload) else { return true }
        if let result = object["result"] as? String, result == "not-loaded" {
            return false
        }
        if let service = object["service"] as? [String: Any],
           let loaded = service["loaded"] as? Bool,
           loaded == false
        {
            return false
        }
        return true
    }

    private static func bringupNotReadyMessage(from payload: Data?) -> String? {
        guard let object = self.parseDaemonObject(payload) else { return nil }
        return (object["message"] as? String) ?? (object["error"] as? String)
    }

    private static func parseDaemonObject(_ payload: Data?) -> [String: Any]? {
        guard let payload else { return nil }
        return (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any]
    }

    private static func summarize(_ text: String) -> String? {
        TextSummarySupport.summarizeLastLine(text)
    }
}

#if DEBUG
extension GatewayLaunchAgentManager {
    static func _testDesiredEnableAction(
        loaded: Bool?,
        hasPlist: Bool,
        launchAgentMatchesCurrentEntrypoint: Bool = true) -> DesiredAction
    {
        self.computeDesiredEnableAction(
            loaded: loaded,
            hasPlist: hasPlist,
            launchAgentMatchesCurrentEntrypoint: launchAgentMatchesCurrentEntrypoint)
    }

    static func _testShouldTreatBringupResultAsReady(_ payload: String) -> Bool {
        self.shouldTreatBringupResultAsReady(payload.data(using: .utf8))
    }
}
#endif
