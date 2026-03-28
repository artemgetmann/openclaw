import Foundation

enum LaunchAgentManager {
    private static var plistURL: URL {
        ConsumerRuntime.appLaunchAgentPlistURL
    }

    static func status() async -> Bool {
        // This toggle represents the user's "launch at login" preference, not whether the
        // current GUI session already has the launchd job loaded. The plist is the durable
        // source of truth for next-login behavior, which is what consumer onboarding needs.
        FileManager().fileExists(atPath: self.plistURL.path)
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

    private static func writePlist(bundlePath: String) {
        let instance = ConsumerInstance.current
        let instanceEnvLines: String
        if let id = instance.id {
            instanceEnvLines = """
          <key>\(ConsumerInstance.envKey)</key>
          <string>\(id)</string>
        """
        } else {
            instanceEnvLines = ""
        }
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
          <key>PATH</key>
          <string>\(CommandResolver.preferredPaths().joined(separator: ":"))</string>
          <key>OPENCLAW_PROFILE</key>
          <string>\(ConsumerRuntime.profile)</string>
          <key>OPENCLAW_HOME</key>
          <string>\(ConsumerRuntime.runtimeRootURL.path)</string>
          <key>OPENCLAW_STATE_DIR</key>
          <string>\(ConsumerRuntime.stateDirURL.path)</string>
          <key>OPENCLAW_CONFIG_PATH</key>
          <string>\(ConsumerRuntime.configURL.path)</string>
          <key>OPENCLAW_GATEWAY_PORT</key>
          <string>\(ConsumerRuntime.gatewayPort)</string>
          <key>OPENCLAW_GATEWAY_BIND</key>
          <string>\(ConsumerRuntime.gatewayBind)</string>
          <key>OPENCLAW_LOG_DIR</key>
          <string>\(ConsumerRuntime.logsDirURL.path)</string>
          <key>OPENCLAW_LAUNCHD_LABEL</key>
          <string>\(ConsumerRuntime.gatewayLaunchdLabel)</string>
          \(instanceEnvLines)
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
