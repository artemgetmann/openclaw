import Darwin
import Foundation
import UserNotifications

/// Pure timing and rate-limit policy for the external packaged Jarvis watchdog.
///
/// The helper deliberately owns no gateway installation logic. Its only mutation
/// is one launchd kickstart of an already-running, exactly-owned Jarvis job.
struct ManagedGatewayWatchdogPolicy: Sendable {
    struct Configuration: Equatable, Sendable {
        let coldStartGrace: TimeInterval
        let failureThreshold: Int
        let recoveryBackoff: TimeInterval
        let notificationBackoff: TimeInterval

        static let production = Self(
            // Packaged startup can spend several minutes in credential/config
            // preflight. Match the native app's existing extended startup budget.
            coldStartGrace: 180,
            // Eight 15-second failures match the proven source-watchdog policy
            // and avoid mistaking a long synchronous task for a frozen runtime.
            failureThreshold: 8,
            recoveryBackoff: 30 * 60,
            notificationBackoff: 6 * 60 * 60)
    }

    enum Observation: Equatable, Sendable {
        /// A release, deliberate stop, or other canonical owner currently has
        /// mutation authority. Start a new grace epoch after it finishes.
        case suppressed(reason: String)
        /// Missing/non-running launchd state is not this watchdog's repair lane.
        case unavailable(reason: String)
        /// A loaded job whose plist is not exact packaged Jarvis ownership.
        case wrongOwnership(reason: String)
        case running(pid: Int32, healthy: Bool)
    }

    enum Action: Equatable, Sendable {
        case none(reason: String)
        case recover(pid: Int32)
        case notify(reason: String)
        case clearIncident
    }

    private let configuration: Configuration

    init(configuration: Configuration = .production) {
        self.configuration = configuration
    }

    mutating func evaluate(
        observation: Observation,
        now: Date,
        state: inout ManagedGatewayWatchdogState) -> Action
    {
        state.lastCheckedAt = now

        switch observation {
        case let .suppressed(reason):
            // A release can retain the same PID while swapping runtime state.
            // Forget the old epoch so the resumed watcher grants full cold-start
            // grace instead of racing the owner that just released its lock.
            state.resetObservationEpoch(now: now, reason: "suppressed:\(reason)")
            return .none(reason: "suppressed:\(reason)")

        case let .unavailable(reason):
            // Never resurrect an intentionally stopped or unregistered service.
            state.resetObservationEpoch(now: now, reason: "unavailable:\(reason)")
            return .none(reason: "unavailable:\(reason)")

        case let .wrongOwnership(reason):
            // Wrong provenance is diagnostic evidence, never restart authority.
            state.resetObservationEpoch(now: now, reason: "wrong-ownership:\(reason)")
            return .none(reason: "wrong-ownership:\(reason)")

        case let .running(pid, healthy):
            if state.observedPID != pid {
                state.observedPID = pid
                state.pidFirstObservedAt = now
                state.consecutiveFailures = 0
                state.lastOutcome = "new-pid-grace"
            }

            if healthy {
                let hadIncident = state.incidentActive
                state.consecutiveFailures = 0
                state.incidentActive = false
                state.lastOutcome = "healthy"
                return hadIncident ? .clearIncident : .none(reason: "healthy")
            }

            let firstObservedAt = state.pidFirstObservedAt ?? now
            if now.timeIntervalSince(firstObservedAt) < self.configuration.coldStartGrace {
                state.lastOutcome = "cold-start-grace"
                return .none(reason: "cold-start-grace")
            }

            state.consecutiveFailures += 1
            state.lastOutcome = "health-failure-\(state.consecutiveFailures)"
            guard state.consecutiveFailures >= self.configuration.failureThreshold else {
                return .none(reason: "bounded-health-failure")
            }

            if let lastRecoveryAttemptAt = state.lastRecoveryAttemptAt,
               now.timeIntervalSince(lastRecoveryAttemptAt) < self.configuration.recoveryBackoff
            {
                state.incidentActive = true
                return self.notificationActionIfDue(
                    now: now,
                    state: &state,
                    reason: "automatic recovery is rate-limited")
            }

            // Record the lease before launchctl runs. A helper crash after this
            // point must not relaunch into a restart storm.
            state.lastRecoveryAttemptAt = now
            state.consecutiveFailures = 0
            state.lastOutcome = "automatic-recovery-requested"
            return .recover(pid: pid)
        }
    }

    mutating func recordRecoveryResult(
        succeeded: Bool,
        now: Date,
        state: inout ManagedGatewayWatchdogState) -> Action
    {
        state.lastCheckedAt = now
        if succeeded {
            // Command success is not health proof. Keep the recovery timestamp
            // for rate limiting; the replacement PID must pass its own health.
            state.lastOutcome = "automatic-recovery-command-succeeded"
            return .none(reason: "awaiting-replacement-health")
        }

        state.incidentActive = true
        state.lastOutcome = "automatic-recovery-command-failed"
        return self.notificationActionIfDue(
            now: now,
            state: &state,
            reason: "automatic recovery failed")
    }

    private func notificationActionIfDue(
        now: Date,
        state: inout ManagedGatewayWatchdogState,
        reason: String) -> Action
    {
        if let lastNotificationAt = state.lastNotificationAt,
           now.timeIntervalSince(lastNotificationAt) < self.configuration.notificationBackoff
        {
            state.lastOutcome = "notification-rate-limited"
            return .none(reason: "notification-rate-limited")
        }

        state.lastNotificationAt = now
        state.lastOutcome = "manual-recovery-required"
        return .notify(reason: reason)
    }
}

/// Persisted diagnostics contain timing, PID, counters, and outcomes only.
/// Tokens, config contents, Telegram messages, and command output are excluded.
struct ManagedGatewayWatchdogState: Codable, Equatable, Sendable {
    var schemaVersion = 1
    var observedPID: Int32?
    var pidFirstObservedAt: Date?
    var consecutiveFailures = 0
    var lastRecoveryAttemptAt: Date?
    var lastNotificationAt: Date?
    var lastCheckedAt: Date?
    var incidentActive = false
    var lastOutcome = "initial"

    mutating func resetObservationEpoch(now: Date, reason: String) {
        // Preserve a stable epoch during a long release or deliberate stop so
        // the runner can throttle unchanged diagnostics writes.
        if self.observedPID != nil || self.lastOutcome != reason {
            self.pidFirstObservedAt = now
        }
        self.observedPID = nil
        self.consecutiveFailures = 0
        self.lastOutcome = reason
    }
}

struct ManagedGatewayWatchdogEnvironment: Equatable, Sendable {
    static let gatewayLabel = "ai.jarvis.gateway"
    static let watchdogLabel = "ai.jarvis.gateway-watchdog"
    static let notificationCategoryIdentifier = "ai.jarvis.gateway-recovery"
    static let notificationActionIdentifier = "ai.jarvis.gateway-recovery.restart"
    /// Match GatewayProcessManager's existing stable identifier so helper and
    /// app fallback delivery replace one incident instead of stacking alerts.
    static let notificationRequestIdentifier = "ai.jarvis.gateway-recovery"

    let homeURL: URL
    let stateDirURL: URL
    let configURL: URL
    let gatewayPlistURL: URL
    let stateURL: URL
    let incidentURL: URL
    let releaseLockURL: URL
    let disableLaunchAgentURL: URL
    let profile: String
    let launchdLabel: String
    let port: Int

    static func resolve(
        processEnvironment: [String: String],
        uid: uid_t = getuid()) throws -> Self
    {
        guard let home = processEnvironment["HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !home.isEmpty
        else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("HOME is missing")
        }

        let homeURL = URL(fileURLWithPath: home, isDirectory: true).standardizedFileURL
        let expectedState = homeURL
            .appendingPathComponent("Library/Application Support/Jarvis/.jarvis", isDirectory: true)
            .standardizedFileURL
        let stateDir = URL(
            fileURLWithPath: processEnvironment["OPENCLAW_STATE_DIR"] ?? "",
            isDirectory: true)
            .standardizedFileURL
        guard stateDir == expectedState else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("state directory is not default Jarvis")
        }

        let expectedConfig = expectedState.appendingPathComponent("openclaw.json").standardizedFileURL
        let config = URL(fileURLWithPath: processEnvironment["OPENCLAW_CONFIG_PATH"] ?? "")
            .standardizedFileURL
        guard config == expectedConfig else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("config is not default Jarvis")
        }

        let profile = processEnvironment["OPENCLAW_PROFILE"] ?? ""
        guard profile == "consumer" else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("profile is not default consumer")
        }
        let label = processEnvironment["OPENCLAW_LAUNCHD_LABEL"] ?? ""
        guard label == Self.gatewayLabel else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("gateway label is not packaged Jarvis")
        }
        guard processEnvironment["OPENCLAW_CONSUMER_INSTANCE_ID"]?.isEmpty != false else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("isolated consumer instance is not allowed")
        }
        guard let port = Int(processEnvironment["OPENCLAW_GATEWAY_PORT"] ?? ""), port == 18789 else {
            throw ManagedGatewayWatchdogError.invalidEnvironment("gateway port is not canonical Jarvis")
        }

        let diagnostics = expectedState.appendingPathComponent("diagnostics", isDirectory: true)
        return Self(
            homeURL: homeURL,
            stateDirURL: expectedState,
            configURL: expectedConfig,
            gatewayPlistURL: homeURL.appendingPathComponent(
                "Library/LaunchAgents/\(Self.gatewayLabel).plist"),
            stateURL: diagnostics.appendingPathComponent("gateway-watchdog-state.json"),
            incidentURL: diagnostics.appendingPathComponent("gateway-watchdog-incident.json"),
            releaseLockURL: URL(
                fileURLWithPath:
                "/tmp/openclaw-jarvis-release-locks-\(uid)/canonical-jarvis-release.lock",
                isDirectory: true),
            disableLaunchAgentURL: expectedState.appendingPathComponent("disable-launchagent"),
            profile: profile,
            launchdLabel: label,
            port: port)
    }

    /// Verify the existing service plist without reading config or secrets.
    /// App-support managed bundles and explicit protected hotfixes are both
    /// acceptable; source checkouts, worktrees, and isolated state are not.
    func validateGatewayOwnership(fileManager: FileManager = .default) -> Result<Void, Error> {
        guard let data = fileManager.contents(atPath: self.gatewayPlistURL.path) else {
            return .failure(ManagedGatewayWatchdogError.wrongOwnership("gateway plist is missing"))
        }

        do {
            guard let plist = try PropertyListSerialization.propertyList(
                from: data,
                options: [],
                format: nil) as? [String: Any]
            else {
                throw ManagedGatewayWatchdogError.wrongOwnership("gateway plist is unreadable")
            }
            guard plist["Label"] as? String == Self.gatewayLabel else {
                throw ManagedGatewayWatchdogError.wrongOwnership("gateway plist label differs")
            }
            guard let arguments = plist["ProgramArguments"] as? [String], !arguments.isEmpty else {
                throw ManagedGatewayWatchdogError.wrongOwnership("gateway command is missing")
            }

            let managedRuntimeRoot = self.stateDirURL
                .appendingPathComponent("lib/openclaw-bundled", isDirectory: true)
                .standardizedFileURL
                .resolvingSymlinksInPath()
                .path
            guard arguments.contains(where: {
                URL(fileURLWithPath: $0)
                    .standardizedFileURL
                    .resolvingSymlinksInPath()
                    .path
                    .hasPrefix(managedRuntimeRoot + "/")
            }) else {
                throw ManagedGatewayWatchdogError.wrongOwnership(
                    "gateway command is not Jarvis Application Support")
            }
            guard !arguments.contains(where: {
                $0.contains("/Programming_Projects/") || $0.contains("/.worktrees/")
            }) else {
                throw ManagedGatewayWatchdogError.wrongOwnership("gateway command references source code")
            }

            guard let environment = plist["EnvironmentVariables"] as? [String: String],
                  environment["OPENCLAW_LAUNCHD_LABEL"] == Self.gatewayLabel,
                  environment["OPENCLAW_PROFILE"] == "consumer",
                  environment["OPENCLAW_STATE_DIR"] == self.stateDirURL.path,
                  environment["OPENCLAW_CONFIG_PATH"] == self.configURL.path,
                  environment["OPENCLAW_GATEWAY_PORT"] == "18789",
                  environment["OPENCLAW_CONSUMER_INSTANCE_ID"]?.isEmpty != false
            else {
                throw ManagedGatewayWatchdogError.wrongOwnership(
                    "gateway environment is not exact default Jarvis")
            }
            return .success(())
        } catch {
            return .failure(error)
        }
    }
}

enum ManagedGatewayWatchdogError: Error, LocalizedError, Equatable {
    case invalidEnvironment(String)
    case wrongOwnership(String)
    case launchctl(String)

    var errorDescription: String? {
        switch self {
        case let .invalidEnvironment(message),
             let .wrongOwnership(message),
             let .launchctl(message):
            message
        }
    }
}

struct ManagedGatewayJobSnapshot: Equatable, Sendable {
    let pid: Int32

    static func parse(_ output: String) -> Self? {
        var running = false
        var pid: Int32?
        for rawLine in output.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == "state = running" {
                running = true
            } else if line.hasPrefix("pid = ") {
                pid = Int32(line.dropFirst("pid = ".count))
            }
        }
        guard running, let pid, pid > 0 else { return nil }
        return Self(pid: pid)
    }
}

struct ManagedGatewayWatchdogStateStore: Sendable {
    let stateURL: URL
    let incidentURL: URL

    func load(fileManager: FileManager = .default) -> ManagedGatewayWatchdogState {
        guard let data = fileManager.contents(atPath: self.stateURL.path),
              let state = try? Self.decoder.decode(ManagedGatewayWatchdogState.self, from: data)
        else {
            return ManagedGatewayWatchdogState()
        }
        return state
    }

    func save(_ state: ManagedGatewayWatchdogState, fileManager: FileManager = .default) throws {
        try fileManager.createDirectory(
            at: self.stateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Self.encoder.encode(state).write(to: self.stateURL, options: .atomic)
    }

    func setIncident(
        active: Bool,
        reason: String?,
        notificationDelivered: Bool = false,
        now: Date,
        fileManager: FileManager = .default) throws
    {
        if !active {
            if fileManager.fileExists(atPath: self.incidentURL.path) {
                try fileManager.removeItem(at: self.incidentURL)
            }
            return
        }

        // Keep the app-facing receipt intentionally tiny and consumer-agnostic.
        // The helper's state file owns counters and timing diagnostics.
        let payload = ManagedGatewayWatchdogIncident(
            schemaVersion: 1,
            active: true,
            detectedAt: now,
            reason: reason ?? "manual recovery required",
            notificationDelivered: notificationDelivered)
        try fileManager.createDirectory(
            at: self.incidentURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Self.encoder.encode(payload).write(to: self.incidentURL, options: .atomic)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

struct ManagedGatewayWatchdogIncident: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let active: Bool
    let detectedAt: Date
    let reason: String
    let notificationDelivered: Bool
}

enum ManagedGatewayRecoveryNotification {
    static func send(appName: String = "Jarvis") async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional
        else {
            // A background helper must not create a surprise permission prompt.
            // The incident receipt remains available to the app on next launch.
            return false
        }

        let restart = UNNotificationAction(
            identifier: ManagedGatewayWatchdogEnvironment.notificationActionIdentifier,
            title: "Restart \(appName)",
            options: [.foreground])
        let category = UNNotificationCategory(
            identifier: ManagedGatewayWatchdogEnvironment.notificationCategoryIdentifier,
            actions: [restart],
            intentIdentifiers: [],
            options: [])
        center.setNotificationCategories([category])

        let content = UNMutableNotificationContent()
        content.title = "\(appName) needs a restart"
        content.body = "\(appName) could not reconnect automatically. Restart it to restore AI access."
        content.categoryIdentifier = ManagedGatewayWatchdogEnvironment.notificationCategoryIdentifier
        content.interruptionLevel = .active
        let request = UNNotificationRequest(
            identifier: ManagedGatewayWatchdogEnvironment.notificationRequestIdentifier,
            content: content,
            trigger: nil)
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

    static func clear() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(
            withIdentifiers: [ManagedGatewayWatchdogEnvironment.notificationRequestIdentifier])
        center.removeDeliveredNotifications(
            withIdentifiers: [ManagedGatewayWatchdogEnvironment.notificationRequestIdentifier])
    }
}
