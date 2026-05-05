import Foundation

enum LaunchAgentManager {
    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchdLabel).plist")
    }

    static func status() async -> Bool {
        guard FileManager().fileExists(atPath: self.plistURL.path) else { return false }
        let result = await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"])
        return result == 0
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
        // First-run consumer default should write the durable login item without
        // kickstarting a second app copy during onboarding/settings bootstrap.
        self.writePlist(bundlePath: bundlePath)
    }

    static func launchAgentEnvironment(
        base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String]
    {
        var env = [
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
        if let id = ConsumerInstance.current.id {
            env[ConsumerInstance.envKey] = id
        }
        if let canonicalSharedGatewayConfigPath = ConsumerRuntime.canonicalSharedGatewayConfigPath {
            env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] = canonicalSharedGatewayConfigPath
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
          <string>\(FileManager().homeDirectoryForCurrentUser.path)</string>
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

    private static func plistEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
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
