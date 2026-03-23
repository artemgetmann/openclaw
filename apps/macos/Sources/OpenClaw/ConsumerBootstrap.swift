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
        // Google Workspace covers common consumer operator tasks like Gmail,
        // Calendar, Drive, and Docs without forcing users into multiple skills.
        "gog",
        "goplaces",
        // Email is a core operator surface; keep one provider-agnostic inbox
        // skill bundled so early users can read, draft, and triage mail.
        "himalaya",
        "peekaboo",
        "summarize",
        "weather",
    ]
    // Consumer bootstrap should never inherit the repo-wide Anthropic fallback.
    // This branch ships an app-owned local runtime with Codex auth seeded under
    // the consumer agent directory, so default to the matching provider/model.
    private static let consumerDefaultModelRef = "openai-codex/gpt-5.4"
    private static let consumerDefaultModelAlias = "GPT"

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
            path: ["agents", "defaults", "model", "primary"],
            value: Self.consumerDefaultModelRef) || changed
        // Keep the allowlist/model catalog aligned with the seeded primary model so
        // runtime model resolution does not fall back to anthropic/claude-opus-4-6
        // just because the consumer config started empty.
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "models", Self.consumerDefaultModelRef, "alias"],
            value: Self.consumerDefaultModelAlias) || changed
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
