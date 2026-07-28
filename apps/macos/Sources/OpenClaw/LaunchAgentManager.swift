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

    /// A safe plist on disk does not prove launchd stopped using the previously
    /// cached KeepAlive job. This marker survives that split-brain window and is
    /// removed only after the replacement plist bootstraps successfully.
    private static var migrationPendingURL: URL {
        self.plistURL.appendingPathExtension("migration-pending")
    }

    static func set(enabled: Bool, bundlePath: String) async {
        // A DMG is a temporary source, not an install location. Persisting its
        // mounted path makes launchd depend on a volume that normally disappears
        // after install and can recreate the legacy relaunch loop while mounted.
        // Keep the stored preference intact so a later /Applications launch can
        // honor it, but treat this run as disabled and clean any stale GUI job.
        let effectiveEnabled = self.shouldPersistLoginItem(
            requestedEnabled: enabled,
            bundlePath: bundlePath)
        let kind = self.registrationKind(bundlePath: bundlePath)
        let migrationPending = FileManager().fileExists(atPath: self.migrationPendingURL.path)
        // Only legacy jobs need an immediate launchd query. A current one-shot job
        // is harmless after `/usr/bin/open` exits. A pending migration is the one
        // exception: disk may be current while launchd still caches the old job.
        let legacyJobLoaded = kind == .legacy || migrationPending ? await self.isJobLoaded() : false
        let plan = self.registrationUpdatePlan(
            enabled: effectiveEnabled,
            kind: kind,
            legacyJobLoaded: legacyJobLoaded,
            migrationPending: migrationPending)

        switch plan {
        case .none:
            return
        case .writeOnly:
            _ = self.writePlist(bundlePath: bundlePath)
        case .replaceLoadedLegacyJob:
            // Write the safe replacement first, then submit migration under a
            // separate transient launchd label. The legacy job may own this exact
            // app process, so its bootout must not also own/terminate the helper that
            // bootstraps the replacement. `open` then relaunches or reuses Jarvis
            // without foreground activation.
            // Never overwrite the only durable legacy evidence unless the pending
            // marker is already durable. If either write fails, leave/recover the
            // legacy plist classification instead of creating an untracked split.
            guard self.writeMigrationPendingMarker() else { return }
            // A previous partial attempt may already have written the safe plist.
            // Reuse it instead of making recovery depend on another successful write.
            guard kind == .current || self.writePlist(bundlePath: bundlePath) else {
                try? FileManager().removeItem(at: self.migrationPendingURL)
                return
            }
            self.scheduleLoadedLegacyJobReplacement()
        case .removeOnly:
            // Current jobs are one-shot and have no KeepAlive policy, so deleting
            // the durable plist is sufficient and deliberately leaves this app open.
            try? FileManager().removeItem(at: self.plistURL)
            try? FileManager().removeItem(at: self.migrationPendingURL)
        case .unloadLegacyJobAndRemove:
            // Deleting a loaded legacy plist does not change launchd's cached
            // KeepAlive policy. Remove durable state first so it stays disabled even
            // if bootout terminates a legacy launchd-owned current app process.
            try? FileManager().removeItem(at: self.plistURL)
            try? FileManager().removeItem(at: self.migrationPendingURL)
            _ = await self.runLaunchctl(["bootout", "gui/\(getuid())/\(launchdLabel)"])
        }
    }

    static func shouldPersistLoginItem(requestedEnabled: Bool, bundlePath: String) -> Bool {
        guard requestedEnabled else { return false }

        // Standardize first so paths such as `/Volumes/Jarvis/../Jarvis/...`
        // cannot bypass the mounted-volume boundary. Do not resolve symlinks:
        // the persisted argument should remain the user's stable installed path.
        let standardizedPath = URL(fileURLWithPath: bundlePath).standardizedFileURL.path
        return standardizedPath != "/Volumes" && !standardizedPath.hasPrefix("/Volumes/")
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
        legacyJobLoaded: Bool,
        migrationPending: Bool = false) -> RegistrationUpdatePlan
    {
        if enabled {
            // The marker outranks the safe-looking disk plist: launchd may still
            // cache the legacy KeepAlive job, or bootout may have succeeded while
            // replacement bootstrap failed. Retry the idempotent migration helper.
            if migrationPending { return .replaceLoadedLegacyJob }
            switch kind {
            case .missing:
                return .writeOnly
            case .current:
                return .none
            case .legacy:
                return legacyJobLoaded ? .replaceLoadedLegacyJob : .writeOnly
            }
        }

        if migrationPending, legacyJobLoaded { return .unloadLegacyJobAndRemove }
        switch kind {
        case .missing:
            return .none
        case .current:
            return .removeOnly
        case .legacy:
            return legacyJobLoaded ? .unloadLegacyJobAndRemove : .removeOnly
        }
    }

    @discardableResult
    private static func writePlist(bundlePath: String) -> Bool {
        let plist = self.renderPlist(bundlePath: bundlePath)
        do {
            try plist.write(to: self.plistURL, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private static func writeMigrationPendingMarker() -> Bool {
        if FileManager().fileExists(atPath: self.migrationPendingURL.path) {
            return true
        }
        do {
            try "pending\n".write(to: self.migrationPendingURL, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private static func isJobLoaded() async -> Bool {
        await self.runLaunchctl(["print", "gui/\(getuid())/\(launchdLabel)"]) == 0
    }

    static func legacyReplacementCommand(
        migrationLabel: String? = nil,
        migrationPendingPath: String? = nil) -> (executable: String, arguments: [String])
    {
        let serviceTarget = "gui/\(getuid())/\(launchdLabel)"
        let guiDomain = "gui/\(getuid())"
        let resolvedMigrationLabel = migrationLabel ?? "\(launchdLabel).login-migration.\(UUID().uuidString)"
        let resolvedMigrationPendingPath = migrationPendingPath ?? self.migrationPendingURL.path
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
                // interpolation. A previous attempt may already have booted out the
                // legacy job, so absence is safe; clear the marker only after bootstrap.
                "/bin/launchctl bootout \"$1\" >/dev/null 2>&1 || true; " +
                    "/bin/launchctl bootstrap \"$2\" \"$3\" && /bin/rm -f \"$4\"",
                "--",
                serviceTarget,
                guiDomain,
                self.plistURL.path,
                resolvedMigrationPendingPath,
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
