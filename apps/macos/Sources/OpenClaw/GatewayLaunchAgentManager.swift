import Foundation

enum GatewayLaunchAgentManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "gateway.launchd")
    #if DEBUG
    // Test-only hooks. The suite is serialized, so unsafe nonisolated storage keeps the
    // production implementation simple while still letting tests observe command selection.
    private nonisolated(unsafe) static var testLaunchAgentWriteDisabledHook: (() -> Bool)?
    private nonisolated(unsafe) static var testReadDaemonLoadedHook: (() async -> Bool?)?
    private nonisolated(unsafe) static var testRunDaemonCommandHook: ((
        _ args: [String],
        _ timeout: Double,
        _ quiet: Bool) async -> String?)?
    #endif

    struct EntrypointOwnership: Equatable {
        let expectedEntrypoint: String?
        let actualEntrypoint: String?

        var matchesCurrentEntrypoint: Bool {
            guard let expectedEntrypoint else { return false }
            return self.actualEntrypoint == expectedEntrypoint
        }
    }

    private struct DisableMarkerMetadata: Encodable {
        let version: Int
        let disabledAt: String
        let source: String
        let reason: String?
        let stateDir: String
        let bundlePath: String?
        let instanceID: String?
        let pid: Int32
    }

    enum DesiredAction: Equatable {
        case noop
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

    private static func disableMarkerMetadata(source: String, reason: String?) -> DisableMarkerMetadata {
        DisableMarkerMetadata(
            version: 1,
            disabledAt: ISO8601DateFormatter().string(from: Date()),
            source: source,
            reason: reason,
            stateDir: OpenClawPaths.stateDirURL.path,
            bundlePath: Bundle.main.bundleURL.path,
            instanceID: ConsumerInstance.current.id,
            pid: ProcessInfo.processInfo.processIdentifier)
    }

    static func setLaunchAgentWriteDisabled(
        _ disabled: Bool,
        source: String = "apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift",
        reason: String? = nil) -> String?
    {
        let marker = self.disableLaunchAgentMarkerURL
        if disabled {
            do {
                try FileManager().createDirectory(
                    at: marker.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                let payload = try encoder.encode(self.disableMarkerMetadata(source: source, reason: reason))
                try payload.write(to: marker, options: [.atomic])
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
            self.logger
                .info("launchd enable requested action=\(String(describing: action), privacy: .public) port=\(port)")
            switch action {
            case .noop:
                return nil
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

        if await self.shouldPreserveLoadedConsumerGatewayOnStop() {
            self.logger.info("launchd stop skipped; consumer app is attached to canonical shared gateway")
            return nil
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
        return await self.restartOrStartLoadedGateway(port: port)
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
        let expectedEntrypoint = self.expectedLaunchAgentEntrypoint()
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
        Telegram live testing is blocked because this app expects \(
            expectedEntrypoint), but the consumer gateway is pinned to \(
            actualEntrypoint). Restart the consumer gateway from this build before capturing the first DM.
        """
    }

    static func launchAgentMatchesCurrentRuntime(snapshot: LaunchAgentPlistSnapshot? = nil) -> Bool {
        guard let snapshot = snapshot ?? self.launchdConfigSnapshot() else { return false }
        let identity = RuntimeIdentity.current
        let env = snapshot.environment

        // The packaged app may use a bundled Node while an existing canonical gateway
        // was started with Homebrew Node. Node path is not ownership. Runtime/config
        // paths are ownership, so only attach when the launchd job is already pinned
        // to the same state root and config file this app would manage.
        let expectedCanonicalConfigPath = ConsumerRuntime.canonicalSharedGatewayConfigPath
        let actualCanonicalConfigPath = env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty

        return snapshot.port == identity.gatewayPort &&
            (snapshot.bind ?? identity.gatewayBind).lowercased() == identity.gatewayBind.lowercased() &&
            env["OPENCLAW_HOME"] == identity.runtimeRootURL.path &&
            env["OPENCLAW_STATE_DIR"] == identity.stateDirURL.path &&
            env["OPENCLAW_CONFIG_PATH"] == identity.configURL.path &&
            actualCanonicalConfigPath == expectedCanonicalConfigPath
    }

    private static func shouldPreserveLoadedConsumerGatewayOnStop() async -> Bool {
        guard AppFlavor.current.isConsumer else { return false }
        guard await self.isLoaded() else { return false }
        guard self.launchAgentMatchesCurrentRuntime() else { return false }
        // Stop preservation is only safe when the loaded service boots this app's
        // current runtime. Preserving a stale source entrypoint keeps replacement
        // installs pinned to old code even though the state/config paths match.
        return self.currentEntrypointOwnership().matchesCurrentEntrypoint
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
        let launchAgentMatchesCurrentRuntime = self.launchAgentMatchesCurrentRuntime(snapshot: snapshot)
        let launchAgentMatchesCurrentEntrypoint = self.launchAgentMatchesCurrentEntrypoint(snapshot: snapshot)
        let launchAgentMatchesCurrentServiceVersion = self.launchAgentMatchesCurrentServiceVersion(
            snapshot: snapshot)
        let action = self.computeDesiredEnableAction(
            loaded: loaded,
            hasPlist: snapshot != nil,
            launchAgentMatchesCurrentRuntime: launchAgentMatchesCurrentRuntime,
            launchAgentMatchesCurrentEntrypoint: launchAgentMatchesCurrentEntrypoint,
            launchAgentMatchesCurrentServiceVersion: launchAgentMatchesCurrentServiceVersion)
        switch action {
        case .noop:
            // A normal enable request means "make sure the service exists". If the
            // matching service is already loaded, do nothing so delayed startup
            // paths cannot bounce a healthy shared gateway.
            return .noop
        case .restart:
            return .restart
        case .start:
            // A plist already exists under the consumer label. Try a normal start first so we
            // re-use the registered service instead of churning install/uninstall state.
            return .start
        case .install, .stop, .uninstall:
            return .install
        }
    }

    private static func restartOrStartLoadedGateway(port: Int) async -> String? {
        let loaded = await self.readDaemonLoaded()
        let snapshot = self.launchdConfigSnapshot()
        let launchAgentMatchesCurrentEntrypoint = self.launchAgentMatchesCurrentEntrypoint(snapshot: snapshot)
        let action = self.computeDesiredRestartAction(
            loaded: loaded,
            hasPlist: snapshot != nil,
            launchAgentMatchesCurrentEntrypoint: launchAgentMatchesCurrentEntrypoint)
        self.logger
            .info("launchd restart requested action=\(String(describing: action), privacy: .public) port=\(port)")
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
        case .noop, .install, .stop, .uninstall:
            break
        }

        return await self.install(port: port)
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

    private static func expectedLaunchAgentEntrypoint() -> String? {
        CommandResolver.gatewayEntrypoint(in: CommandResolver.gatewayLaunchProjectRoot())
    }

    private static func launchAgentMatchesCurrentServiceVersion(snapshot: LaunchAgentPlistSnapshot?) -> Bool {
        guard let expected = self.currentServiceVersionString() else { return true }
        guard let actual = snapshot?.environment["OPENCLAW_SERVICE_VERSION"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty
        else {
            return true
        }
        return self.normalizedVersionString(actual) == self.normalizedVersionString(expected)
    }

    static func currentServiceVersionString() -> String? {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return version?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    private static func normalizedVersionString(_ raw: String) -> String {
        raw.replacingOccurrences(of: "^v", with: "", options: .regularExpression)
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
        let gatewayRoot = self.daemonCommandProjectRoot()
        let command = CommandResolver.openclawCommand(
            subcommand: "gateway",
            extraArgs: self.withJsonFlag(args),
            // Launchd management must always run locally, even if remote mode is configured.
            configRoot: ["gateway": ["mode": "local"]],
            projectRoot: gatewayRoot)
        let env = self.daemonCommandEnvironment(
            base: ProcessInfo.processInfo.environment)
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

    private static func daemonCommandProjectRoot() -> URL {
        let projectRoot = CommandResolver.projectRoot()
        let identity = RuntimeIdentity.current

        // The default/shared gateway label is a single long-lived service. When
        // a dev app is built from `.worktrees`, daemon commands for that shared
        // service must still execute from the canonical main checkout that owns
        // the user's default gateway.
        guard identity.gatewayLaunchdLabel != "ai.openclaw.gateway" else {
            return CommandResolver.canonicalGatewayProjectRoot(projectRoot: projectRoot)
        }

        // Isolated consumer instances have their own label, state, port, and
        // profile. Canonicalizing those commands back to the shared main checkout
        // makes a smoke lane manage the wrong code, so keep the root resolved
        // from env/defaults/bundled runtime.
        return projectRoot
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
        projectRootHint: String? = CommandResolver.daemonProjectRootEnvironmentHint()) -> [String: String]
    {
        let identity = RuntimeIdentity.current
        let instance = ConsumerInstance.current
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR"] {
            let value = base[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !value.isEmpty {
                env[key] = value
            }
        }
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        env["OPENCLAW_PROFILE"] = identity.profile ?? "default"
        env["OPENCLAW_HOME"] = identity.runtimeRootURL.path
        env["OPENCLAW_STATE_DIR"] = identity.stateDirURL.path
        env["OPENCLAW_CONFIG_PATH"] = identity.configURL.path
        if let canonicalSharedGatewayConfigPath = ConsumerRuntime.canonicalSharedGatewayConfigPath {
            env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] = canonicalSharedGatewayConfigPath
        }
        env["OPENCLAW_GATEWAY_PORT"] = "\(identity.gatewayPort)"
        env["OPENCLAW_GATEWAY_BIND"] = identity.gatewayBind
        env["OPENCLAW_LOG_DIR"] = identity.logsDirURL.path
        env["OPENCLAW_CONSUMER_MINIMAL_STARTUP"] = "1"
        // Packaged consumer runs through Bun on macOS; default to sips unless
        // the caller intentionally asks for the sharp backend.
        env["OPENCLAW_IMAGE_BACKEND"] =
            base["OPENCLAW_IMAGE_BACKEND"]?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? ConsumerRuntime.imageBackend
        if let id = instance.id {
            env[ConsumerInstance.envKey] = id
        } else {
            env.removeValue(forKey: ConsumerInstance.envKey)
        }
        // Keep every child CLI command pinned to the dedicated consumer gateway lane.
        // The app and gateway intentionally use different launchd labels, and the explicit
        // env keeps status/install/restart commands from drifting across authorities.
        env["OPENCLAW_LAUNCHD_LABEL"] = identity.gatewayLaunchdLabel
        if let projectRootHint, !projectRootHint.isEmpty {
            env["OPENCLAW_FORK_ROOT"] = projectRootHint
        }
        ConsumerRuntime.applyInheritedToolIsolationEnvironment(to: &env, base: base)
        return env
    }

    private static func withJsonFlag(_ args: [String]) -> [String] {
        if args.contains("--json") { return args }
        return args + ["--json"]
    }

    /// Keep the decision logic in a non-DEBUG helper so release packaging can reuse the
    /// same branch selection that tests assert against.
    private static func computeDesiredEnableAction(
        loaded: Bool?,
        hasPlist: Bool,
        launchAgentMatchesCurrentRuntime: Bool = true,
        launchAgentMatchesCurrentEntrypoint: Bool = true,
        launchAgentMatchesCurrentServiceVersion: Bool = true) -> DesiredAction
    {
        // Enable/first-launch is the repair path. Runtime ownership protects the
        // user's app-owned state, but entrypoint ownership decides whether the
        // loaded job actually boots this app's bundled runtime.
        if hasPlist, !launchAgentMatchesCurrentRuntime { return .install }
        if hasPlist, !launchAgentMatchesCurrentEntrypoint { return .install }
        // Sparkle can refresh the bundle while launchd keeps the old env block alive.
        // If the service version is stale, reinstall so launchd rewrites that block.
        if hasPlist, !launchAgentMatchesCurrentServiceVersion { return .install }
        if loaded == true { return .noop }
        if loaded == false, hasPlist { return .start }
        if loaded == nil, hasPlist { return .start }
        return .install
    }

    private static func computeDesiredRestartAction(
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
        launchAgentMatchesCurrentRuntime: Bool = true,
        launchAgentMatchesCurrentEntrypoint: Bool = true,
        launchAgentMatchesCurrentServiceVersion: Bool = true) -> DesiredAction
    {
        self.computeDesiredEnableAction(
            loaded: loaded,
            hasPlist: hasPlist,
            launchAgentMatchesCurrentRuntime: launchAgentMatchesCurrentRuntime,
            launchAgentMatchesCurrentEntrypoint: launchAgentMatchesCurrentEntrypoint,
            launchAgentMatchesCurrentServiceVersion: launchAgentMatchesCurrentServiceVersion)
    }

    static func _testShouldTreatBringupResultAsReady(_ payload: String) -> Bool {
        self.shouldTreatBringupResultAsReady(payload.data(using: .utf8))
    }

    static func _testDaemonCommandProjectRoot() -> URL {
        self.daemonCommandProjectRoot()
    }
}
#endif
