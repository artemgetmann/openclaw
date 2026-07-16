import Foundation

enum LaunchAgentManager {
    enum RegistrationKind: Equatable {
        case missing
        case current
        case legacy
    }

    enum RegistrationUpdatePlan: Equatable {
        case none
        /// Persist the login item for the next login without launching the app now.
        case writeOnly
        /// Replace a loaded direct-executable/KeepAlive job that is already respawning the app.
        case replaceLoadedLegacyJob
        case removeOnly
        /// A loaded legacy job retains its KeepAlive policy after its plist is deleted.
        case unloadLegacyJobAndRemove
    }

    private static var plistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchdLabel).plist")
    }

    static func set(enabled: Bool, bundlePath: String) async {
        let kind = self.registrationKind(bundlePath: bundlePath)
        // Only legacy jobs need an immediate launchd query. A current one-shot job
        // is harmless after `/usr/bin/open` exits, and bootstrapping a missing/current
        // registration while this app is open would violate the no-duplicate contract.
        let legacyJobLoaded = kind == .legacy ? await self.isJobLoaded() : false
        let plan = self.registrationUpdatePlan(
            enabled: enabled,
            kind: kind,
            legacyJobLoaded: legacyJobLoaded)

        switch plan {
        case .none:
            return
        case .writeOnly:
            self.writePlist(bundlePath: bundlePath)
        case .replaceLoadedLegacyJob:
            // Write the safe replacement first, then submit migration under a
            // separate transient launchd label. The legacy job may own this exact
            // app process, so its bootout must not also own/terminate the helper that
            // bootstraps the replacement. `open` then relaunches or reuses Jarvis
            // without foreground activation.
            self.writePlist(bundlePath: bundlePath)
            self.scheduleLoadedLegacyJobReplacement()
        case .removeOnly:
            // Current jobs are one-shot and have no KeepAlive policy, so deleting
            // the durable plist is sufficient and deliberately leaves this app open.
            try? FileManager().removeItem(at: self.plistURL)
        case .unloadLegacyJobAndRemove:
            // Deleting a loaded legacy plist does not change launchd's cached
            // KeepAlive policy. Remove durable state first so it stays disabled even
            // if bootout terminates a legacy launchd-owned current app process.
            try? FileManager().removeItem(at: self.plistURL)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
        }
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

    static func renderPlist(
        bundlePath: String,
        environment: [String: String]? = nil) -> String
    {
        let env = environment ?? self.launchAgentEnvironment()
        let envLines = env.keys.sorted().compactMap { key -> String? in
            guard let value = env[key], !value.isEmpty else { return nil }
            return """
            <key>\(self.plistEscape(key))</key>
            <string>\(self.plistEscape(value))</string>
            """
        }.joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(launchdLabel)</string>
          <key>ProgramArguments</key>
          <array>
            <string>/usr/bin/open</string>
            <string>-gja</string>
            <string>\(self.plistEscape(bundlePath))</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(FileManager().homeDirectoryForCurrentUser.path)</string>
          <key>RunAtLoad</key>
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
    }

    static func registrationKind(bundlePath: String, plistData: Data? = nil) -> RegistrationKind {
        let data = plistData ?? (try? Data(contentsOf: self.plistURL))
        guard let data else { return .missing }
        guard let root = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let plist = root as? [String: Any]
        else { return .legacy }

        let arguments = plist["ProgramArguments"] as? [String]
        let runAtLoad = plist["RunAtLoad"] as? Bool
        let keepAlive = plist["KeepAlive"] as? Bool
        let isCurrent = plist["Label"] as? String == launchdLabel &&
            arguments == ["/usr/bin/open", "-gja", bundlePath] &&
            runAtLoad == true &&
            keepAlive != true
        return isCurrent ? .current : .legacy
    }

    static func registrationUpdatePlan(
        enabled: Bool,
        kind: RegistrationKind,
        legacyJobLoaded: Bool) -> RegistrationUpdatePlan
    {
        if enabled {
            switch kind {
            case .missing:
                return .writeOnly
            case .current:
                return .none
            case .legacy:
                return legacyJobLoaded ? .replaceLoadedLegacyJob : .writeOnly
            }
        }

        switch kind {
        case .missing:
            return .none
        case .current:
            return .removeOnly
        case .legacy:
            return legacyJobLoaded ? .unloadLegacyJobAndRemove : .removeOnly
        }
    }

    private static func writePlist(bundlePath: String) {
        let plist = self.renderPlist(bundlePath: bundlePath)
        try? plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
    }

    private static func isJobLoaded() async -> Bool {
        await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"]) == 0
    }

    static func legacyReplacementCommand(
        migrationLabel: String? = nil) -> (executable: String, arguments: [String])
    {
        let serviceTarget = "gui/\(getuid())/\(launchdLabel)"
        let guiDomain = "gui/\(getuid())"
        let resolvedMigrationLabel = migrationLabel ?? "\(launchdLabel).login-migration.\(UUID().uuidString)"
        return (
            executable: "/bin/launchctl",
            arguments: [
                "submit",
                "-l",
                resolvedMigrationLabel,
                "--",
                "/bin/sh",
                "-c",
                // Positional parameters keep the label and plist path out of shell
                // interpolation. Bootstrap runs only after a successful bootout.
                "/bin/launchctl bootout \"$1\" && /bin/launchctl bootstrap \"$2\" \"$3\"",
                "--",
                serviceTarget,
                guiDomain,
                self.plistURL.path,
            ])
    }

    private static func scheduleLoadedLegacyJobReplacement() {
        let command = self.legacyReplacementCommand()
        let process = Process()
        process.launchPath = command.executable
        process.arguments = command.arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Best effort matches the existing login-item error contract. Once submit
        // succeeds, launchd—not the legacy app job—owns the migration helper.
        try? process.run()
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
