import Foundation

enum ConsumerBootstrap {
    // Curated starter skills keep the consumer install useful without dumping the
    // full skill catalog into the default prompt footprint.
    private static let bundledSkillAllowlist = [
        "apple-notes",
        "apple-reminders",
        "bear-notes",
        "camsnap",
        "canvas",
        "goplaces",
        "peekaboo",
        "summarize",
        "weather",
    ]

    static func bootstrapIfNeeded() {
        self.ensureConsumerDirectories()
        self.ensureConsumerConfig()
        self.ensureConsumerWorkspace()
    }

    private static func ensureConsumerDirectories() {
        let fm = FileManager()
        let urls = [
            ConsumerRuntime.runtimeRootURL,
            ConsumerRuntime.stateDirURL,
            ConsumerRuntime.logsDirURL,
            ConsumerRuntime.workspaceURL,
        ]
        for url in urls {
            try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private static func ensureConsumerConfig() {
        let configURL = OpenClawConfigFile.url()
        let fm = FileManager()
        var root = fm.fileExists(atPath: configURL.path) ? OpenClawConfigFile.loadDict() : [:]
        guard self.applyMissingConfigDefaults(to: &root) else { return }
        OpenClawConfigFile.saveDict(root)
    }

    static func applyMissingConfigDefaults(to root: inout [String: Any]) -> Bool {
        var changed = false

        // Seed only missing values so we keep the consumer runtime opinionated
        // without stomping on settings a user already changed.
        changed = self.setDefaultValue(
            in: &root,
            path: ["gateway", "mode"],
            value: "local") || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["gateway", "port"],
            value: ConsumerRuntime.gatewayPort) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["gateway", "bind"],
            value: ConsumerRuntime.gatewayBind) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "workspace"],
            value: ConsumerRuntime.workspaceURL.path) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["skills", "install", "nodeManager"],
            value: "npm") || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["skills", "allowBundled"],
            value: Self.bundledSkillAllowlist) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["discovery", "mdns", "mode"],
            value: "off") || changed

        return changed
    }

    private static func ensureConsumerWorkspace() {
        let workspaceURL = ConsumerRuntime.workspaceURL
        guard AgentWorkspace.bootstrapSafety(for: workspaceURL).unsafeReason == nil else {
            return
        }
        _ = try? AgentWorkspace.bootstrap(workspaceURL: workspaceURL)
    }

    private static func setDefaultValue(
        in root: inout [String: Any],
        path: [String],
        value: Any) -> Bool
    {
        guard let key = path.first else { return false }
        if path.count == 1 {
            guard root[key] == nil else { return false }
            root[key] = value
            return true
        }

        var child = root[key] as? [String: Any] ?? [:]
        let childChanged = self.setDefaultValue(
            in: &child,
            path: Array(path.dropFirst()),
            value: value)
        guard childChanged else { return false }
        root[key] = child
        return true
    }
}
