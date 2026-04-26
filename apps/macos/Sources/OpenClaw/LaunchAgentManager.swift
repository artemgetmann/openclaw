import Foundation
import OSLog

enum LaunchAgentManager {
    struct LaunchAgentSnapshot: Equatable {
        let programArguments: [String]
        let environment: [String: String]
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "app.launchd")
    private static var plistURL: URL {
        ConsumerRuntime.appLaunchAgentPlistURL
    }

    private static func plistEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    static func status() async -> Bool {
        // This toggle represents the user's "launch at login" preference, not whether the
        // current GUI session already has the launchd job loaded. The plist is the durable
        // source of truth for next-login behavior, which is what consumer onboarding needs.
        FileManager().fileExists(atPath: self.plistURL.path)
    }

    static func needsRefresh(
        bundlePath: String,
        base: [String: String] = ProcessInfo.processInfo.environment) -> Bool
    {
        self.needsRefresh(
            snapshot: self.snapshot(),
            bundlePath: bundlePath,
            base: base)
    }

    static func set(enabled: Bool, bundlePath: String) async {
        if enabled {
            self.writePlist(bundlePath: bundlePath)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
            _ = await self.runLaunchctl(["bootstrap", "gui/\(getuid())", self.plistURL.path])
            _ = await self.runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"])
        } else {
            // Disable autostart going forward but leave the current app running.
            // bootout would terminate the launchd job immediately (and crash the app if launched via agent).
            try? FileManager().removeItem(at: self.plistURL)
        }
    }

    static func registerForNextLogin(bundlePath: String) async {
        // First-run consumer default should not kickstart a second copy of the app mid-onboarding.
        // Writing the plist is enough for next-login autostart while keeping this session stable.
        self.writePlist(bundlePath: bundlePath)
    }

    static func detachCurrentSessionJob() {
        // Standard Quit should stop this session's app job from being supervised by launchd.
        // We fire launchctl as a separate process so termination can continue normally without
        // turning Quit into a custom UX flow.
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = ["bootout", "gui/\(getuid())/\(launchdLabel)"]
        do {
            try process.run()
        } catch {
            self.logger.warning(
                "failed to detach app launchd job on quit: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func launchAgentEnvironment(
        base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String]
    {
        let instance = ConsumerInstance.current
        var env: [String: String] = [
            "PATH": CommandResolver.preferredPaths().joined(separator: ":"),
            "OPENCLAW_PROFILE": ConsumerRuntime.profile,
            "OPENCLAW_HOME": ConsumerRuntime.runtimeRootURL.path,
            "OPENCLAW_STATE_DIR": ConsumerRuntime.stateDirURL.path,
            "OPENCLAW_CONFIG_PATH": ConsumerRuntime.configURL.path,
            "OPENCLAW_GATEWAY_PORT": ConsumerRuntime.gatewayPort.description,
            "OPENCLAW_GATEWAY_BIND": ConsumerRuntime.gatewayBind,
            "OPENCLAW_LOG_DIR": ConsumerRuntime.logsDirURL.path,
            "OPENCLAW_LAUNCHD_LABEL": ConsumerRuntime.gatewayLaunchdLabel,
            "OPENCLAW_IMAGE_BACKEND": base["OPENCLAW_IMAGE_BACKEND"]?
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? ConsumerRuntime.imageBackend,
        ]
        if let id = instance.id {
            env[ConsumerInstance.envKey] = id
        }
        ConsumerRuntime.applyInheritedToolIsolationEnvironment(to: &env, base: base)
        return env
    }

    private static func writePlist(bundlePath: String) {
        let env = self.launchAgentEnvironment()
        let envLines = env.keys.sorted().compactMap { key -> String? in
            guard let value = env[key], !value.isEmpty else { return nil }
            return """
              <key>\(self.plistEscape(key))</key>
              <string>\(self.plistEscape(value))</string>
            """
        }.joined(separator: "\n")
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(launchdLabel)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(bundlePath)/Contents/MacOS/OpenClaw</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(ConsumerRuntime.runtimeRootURL.path)</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
        <key>EnvironmentVariables</key>
        <dict>
        \(envLines)
        </dict>
          <key>StandardOutPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
          <key>StandardErrorPath</key>
          <string>\(LogLocator.launchdLogPath)</string>
        </dict>
        </plist>
        """
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    private static func snapshot() -> LaunchAgentSnapshot? {
        guard
            let data = try? Data(contentsOf: self.plistURL),
            let raw = try? PropertyListSerialization.propertyList(
                from: data,
                format: nil) as? [String: Any]
        else {
            return nil
        }
        let programArguments = raw["ProgramArguments"] as? [String] ?? []
        let environment = raw["EnvironmentVariables"] as? [String: String] ?? [:]
        return LaunchAgentSnapshot(programArguments: programArguments, environment: environment)
    }

    static func needsRefresh(
        snapshot: LaunchAgentSnapshot?,
        bundlePath: String,
        base: [String: String]) -> Bool
    {
        guard let snapshot else { return true }
        let expectedBinary = "\(bundlePath)/Contents/MacOS/OpenClaw"
        guard snapshot.programArguments.first == expectedBinary else { return true }
        let expectedEnv = self.launchAgentEnvironment(base: base)
        for (key, value) in expectedEnv {
            if snapshot.environment[key] != value {
                return true
            }
        }
        return false
    }

    @discardableResult
    private static func runLaunchctl(_ args: [String]) async -> Int32 {
        await Task.detached(priority: .utility) { () -> Int32 in
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                _ = try process.runAndReadToEnd(from: pipe)
                return process.terminationStatus
            } catch {
                return -1
            }
        }.value
    }
}
