import Foundation

enum ConsumerBootstrap {
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
        return changed
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
