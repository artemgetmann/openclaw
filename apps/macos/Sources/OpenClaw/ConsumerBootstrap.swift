import Foundation
import OSLog

enum ConsumerBootstrap {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "consumer.bootstrap")
    // Jarvis users often send a thought as several rapid Telegram messages.
    // A short Telegram-only debounce turns that burst into one agent turn while
    // leaving other channels unchanged and preserving an explicit user opt-out.
    private static let telegramInboundDebounceMs = 1000
    private static let defaultTypingMode = "instant"
    private static let defaultBrowserProfile = "signed-in"
    private static let legacyBrowserProfile = "user"
    private static let retiredBrowserProfile = "openclaw"
    private static let signedInBrowserColor = "#1F9D55"

    static func bootstrapIfNeeded() {
        guard AppFlavor.current.isConsumer else { return }
        self.ensureRuntimeDefaults()
        self.ensureDirectories()
        self.ensureConfig()
        self.ensureProactiveHeartbeatPolicy()
    }

    private static func ensureRuntimeDefaults() {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: locationModeKey) == nil {
            defaults.set("whileUsing", forKey: locationModeKey)
        }
        if defaults.object(forKey: locationPreciseKey) == nil {
            defaults.set(true, forKey: locationPreciseKey)
        }
    }

    private static func ensureDirectories(fileManager: FileManager = .default) {
        for url in [
            ConsumerRuntime.runtimeRootURL,
            ConsumerRuntime.stateDirURL,
            ConsumerRuntime.logsDirURL,
            ConsumerRuntime.workspaceURL,
        ] {
            try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private static func ensureConfig() {
        var root = OpenClawConfigFile.loadDict()
        guard self.applyMissingConfigDefaults(to: &root, seededDefaults: self.loadSeededDefaults()) else { return }
        OpenClawConfigFile.saveDict(root)
    }

    static func applyMissingConfigDefaults(to root: inout [String: Any]) -> Bool {
        self.applyMissingConfigDefaults(to: &root, seededDefaults: [:])
    }

    static func applyMissingConfigDefaults(to root: inout [String: Any], seededDefaults: [String: Any]) -> Bool {
        var changed = false
        // Packaged Jarvis builds can carry product-owned defaults that must be
        // present before onboarding starts. Merge only missing leaves so user
        // edits and recovered configs always win over bundled seed data.
        changed = self.applySeededDefaults(seededDefaults, to: &root) || changed
        changed = self.refreshPackagedBackendAccessToken(seededDefaults: seededDefaults, root: &root) || changed
        // Upgrade the browser selection before filling missing defaults. Older
        // Jarvis builds persisted both the legacy `user` clone and the isolated
        // engine browser, so a missing-only write would leave existing users on
        // the retired three-browser contract forever.
        changed = self.migrateRetiredBrowserProfiles(in: &root) || changed
        changed = self.setDefaultValue(in: &root, path: ["gateway", "mode"], value: "local") || changed
        changed = self
            .setDefaultValue(in: &root, path: ["gateway", "port"], value: ConsumerRuntime.gatewayPort) || changed
        changed = self
            .setDefaultValue(in: &root, path: ["gateway", "bind"], value: ConsumerRuntime.gatewayBind) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "workspace"],
            value: ConsumerRuntime.workspaceURL.path) || changed
        changed = self.setDefaultValue(in: &root, path: ["tools", "exec", "host"], value: "gateway") || changed
        // Jarvis defaults to its cloned signed-in Chrome lane. The generic
        // OpenClaw engine defaults to the isolated browser when this key is
        // absent, which contradicts Jarvis's browser tool contract.
        changed = self.setDefaultValue(
            in: &root,
            path: ["browser", "defaultProfile"],
            value: self.defaultBrowserProfile) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["messages", "inbound", "byChannel", "telegram"],
            value: self.telegramInboundDebounceMs) || changed
        // Reaching this config means Jarvis has already accepted the inbound
        // message. Start the honest activity signal at that boundary instead
        // of waiting for the model's first visible token in Telegram topics.
        // Missing-only semantics preserve explicit operator preferences.
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "typingMode"],
            value: self.defaultTypingMode) || changed
        changed = self.applyProactiveHeartbeatDefaults(to: &root) || changed
        return changed
    }

    /// Routes proactive alerts only after consumer onboarding has identified
    /// exactly one Telegram owner. Using generic `target: last` could leak a
    /// private reminder into a group that happened to be the latest route.
    @discardableResult
    static func applyProactiveHeartbeatDefaults(to root: inout [String: Any]) -> Bool {
        let agents = root["agents"] as? [String: Any]
        let defaults = agents?["defaults"] as? [String: Any]
        let heartbeat = defaults?["heartbeat"] as? [String: Any]
        guard self.valueIsMissing(heartbeat?["target"]),
              let route = self.singleTelegramOwnerRoute(from: root)
        else {
            return false
        }

        var changed = false
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "heartbeat", "target"],
            value: "telegram") || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "heartbeat", "to"],
            value: route.ownerId) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "heartbeat", "accountId"],
            value: route.accountId) || changed
        return changed
    }

    private static func ensureProactiveHeartbeatPolicy() {
        let configured = AgentWorkspaceConfig.workspace(from: OpenClawConfigFile.loadDict())
        let workspaceURL = AgentWorkspace.resolveWorkspaceURL(from: configured)
        do {
            _ = try AgentWorkspace.bootstrapConsumerHeartbeatPolicyIfSafe(workspaceURL: workspaceURL)
        } catch {
            // A failed migration must never block app startup. Log only the
            // filesystem error; workspace content is private and stays out of
            // diagnostics.
            self.logger.error("consumer heartbeat policy bootstrap failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func migrateRetiredBrowserProfiles(in root: inout [String: Any]) -> Bool {
        guard var browser = root["browser"] as? [String: Any] else { return false }
        var changed = false
        var migratedLegacySelection = false
        var profiles = browser["profiles"] as? [String: Any] ?? [:]

        if let legacy = profiles[self.legacyBrowserProfile] as? [String: Any],
           legacy["driver"] as? String == "openclaw",
           legacy["cloneFromUserProfile"] as? Bool == true,
           legacy["color"] as? String == "#00AA00",
           let rawSource = legacy["sourceProfileName"] as? String
        {
            let source = rawSource.trimmingCharacters(in: .whitespacesAndNewlines)
            let appOwnedKeys: Set<String> = [
                "cdpPort",
                "driver",
                "cloneFromUserProfile",
                "sourceChromeDir",
                "sourceProfileName",
                "profileDirectory",
                "color",
            ]

            // Migrate only the shape written by old Jarvis onboarding. A
            // literal custom profile named `user` may belong to an operator and
            // must not be rewritten or removed.
            if !source.isEmpty, Set(legacy.keys).isSubset(of: appOwnedKeys) {
                if profiles[self.defaultBrowserProfile] == nil {
                    var signedIn: [String: Any] = [
                        "driver": "existing-session",
                        "cloneFromUserProfile": true,
                        "sourceProfileName": source,
                        "profileDirectory": "Default",
                        "color": self.signedInBrowserColor,
                    ]
                    if let cdpPort = legacy["cdpPort"] {
                        signedIn["cdpPort"] = cdpPort
                    }
                    if let sourceChromeDir = legacy["sourceChromeDir"] {
                        // Some Chrome channels and test installations use a
                        // non-default data root. Preserve it or the migrated
                        // profile could clone the wrong account.
                        signedIn["sourceChromeDir"] = sourceChromeDir
                    }
                    profiles[self.defaultBrowserProfile] = signedIn
                }
                profiles.removeValue(forKey: self.legacyBrowserProfile)
                migratedLegacySelection = true
                changed = true
            }
        }

        if let retired = profiles[self.retiredBrowserProfile] as? [String: Any] {
            let appOwnedKeys: Set<String> = ["cdpPort", "color", "driver"]
            // Remove only the default profile declaration Jarvis used to own.
            // Browser data remains on disk until the separately tracked,
            // owner-confirmed cleanup proves it is safe to quarantine. Keep the
            // gate in docs/jarvis/browser-profile-retirement.md until done.
            let driver = retired["driver"] as? String
            if retired["color"] as? String == "#FF4500",
               driver == nil || driver == "openclaw",
               Set(retired.keys).isSubset(of: appOwnedKeys)
            {
                profiles.removeValue(forKey: self.retiredBrowserProfile)
                changed = true
            }
        }

        let currentDefault = (browser["defaultProfile"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if currentDefault == self.retiredBrowserProfile ||
            (currentDefault == self.legacyBrowserProfile && migratedLegacySelection)
        {
            browser["defaultProfile"] = self.defaultBrowserProfile
            changed = true
        }

        if profiles.isEmpty {
            browser.removeValue(forKey: "profiles")
        } else {
            browser["profiles"] = profiles
        }
        root["browser"] = browser
        return changed
    }

    @discardableResult
    private static func refreshPackagedBackendAccessToken(
        seededDefaults: [String: Any],
        root: inout [String: Any])
        -> Bool
    {
        guard let seededBackend = self.jarvisBackend(from: seededDefaults),
              let seededAccessToken = self.trimmedString(seededBackend["accessToken"]),
              let seededBaseURL = self.trimmedString(seededBackend["baseUrl"])
        else {
            return false
        }

        var jarvis = root["jarvis"] as? [String: Any] ?? [:]
        var backend = jarvis["backend"] as? [String: Any] ?? [:]
        let currentBaseURL = self.trimmedString(backend["baseUrl"])
        let currentAccessToken = self.trimmedString(backend["accessToken"])

        // The Jarvis backend bearer is build-owned, not a user account secret.
        // When a user updates from a package with a stale bearer, missing-only
        // merging keeps them broken forever. Refresh only the product backend
        // surface; custom backends keep their existing non-empty token.
        guard currentBaseURL == nil || currentBaseURL == seededBaseURL else {
            return false
        }
        guard currentAccessToken != seededAccessToken else {
            return false
        }

        backend["baseUrl"] = seededBaseURL
        backend["accessToken"] = seededAccessToken
        jarvis["backend"] = backend
        root["jarvis"] = jarvis
        return true
    }

    private static func loadSeededDefaults(bundle: Bundle = .main) -> [String: Any] {
        guard let url = bundle.url(forResource: "consumer-seeded-defaults", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return [:]
        }
        return root
    }

    private static func jarvisBackend(from root: [String: Any]) -> [String: Any]? {
        (root["jarvis"] as? [String: Any])?["backend"] as? [String: Any]
    }

    private static func singleTelegramOwnerRoute(
        from root: [String: Any])
        -> (ownerId: String, accountId: String)?
    {
        guard let telegram = (root["channels"] as? [String: Any])?["telegram"] as? [String: Any]
        else {
            return nil
        }

        let accountId = self.trimmedString(telegram["defaultAccount"]) ?? "default"
        let account = (telegram["accounts"] as? [String: Any])?[accountId] as? [String: Any]
        // Upgrade-era configs can hold authorization at either level. Merge
        // both and require one unique owner; conflicting stale values stay
        // ambiguous instead of silently preferring one layer.
        let accountOwners = account?["allowFrom"] as? [String] ?? []
        let channelOwners = telegram["allowFrom"] as? [String] ?? []
        let rawOwners = accountOwners + channelOwners
        let owners = Array(Set(rawOwners.compactMap(self.trimmedString))).sorted()

        // Consumer Telegram onboarding stores numeric sender IDs. Reject
        // usernames, wildcards, and multiple owners instead of guessing where
        // private life reminders belong.
        guard owners.count == 1,
              let ownerId = owners.first,
              ownerId.allSatisfy(\.isNumber)
        else {
            return nil
        }
        return (ownerId, accountId)
    }

    private static func trimmedString(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    @discardableResult
    private static func applySeededDefaults(_ defaults: [String: Any], to root: inout [String: Any]) -> Bool {
        var changed = false
        for (key, value) in defaults {
            if let nestedDefaults = value as? [String: Any] {
                var nestedRoot = root[key] as? [String: Any] ?? [:]
                let nestedChanged = self.applySeededDefaults(nestedDefaults, to: &nestedRoot)
                if nestedChanged || self.valueIsMissing(root[key]) {
                    root[key] = nestedRoot
                    changed = true
                }
                continue
            }
            if self.valueIsMissing(root[key]) {
                root[key] = value
                changed = true
            }
        }
        return changed
    }

    @discardableResult
    private static func setDefaultValue(
        in root: inout [String: Any],
        path: [String],
        value: Any)
        -> Bool
    {
        guard !path.isEmpty else { return false }
        if path.count == 1 {
            let key = path[0]
            if self.valueIsMissing(root[key]) {
                root[key] = value
                return true
            }
            return false
        }

        let key = path[0]
        var child = root[key] as? [String: Any] ?? [:]
        let changed = self.setDefaultValue(in: &child, path: Array(path.dropFirst()), value: value)
        if changed {
            root[key] = child
        }
        return changed
    }

    private static func valueIsMissing(_ value: Any?) -> Bool {
        guard let value else { return true }
        if let string = value as? String {
            return string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if value is NSNull { return true }
        return false
    }
}
