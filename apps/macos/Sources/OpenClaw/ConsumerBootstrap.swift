import Foundation

enum ConsumerBootstrap {
    // Jarvis users often send a thought as several rapid Telegram messages.
    // A short Telegram-only debounce turns that burst into one agent turn while
    // leaving other channels unchanged and preserving an explicit user opt-out.
    private static let telegramInboundDebounceMs = 1000

    static func bootstrapIfNeeded() {
        guard AppFlavor.current.isConsumer else { return }
        self.ensureRuntimeDefaults()
        self.ensureDirectories()
        self.ensureConfig()
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
        changed = self.setDefaultValue(
            in: &root,
            path: ["messages", "inbound", "byChannel", "telegram"],
            value: self.telegramInboundDebounceMs) || changed
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
