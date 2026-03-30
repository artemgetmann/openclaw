import Darwin
import Foundation
import OpenClawKit

enum ConsumerBootstrap {
    // Curated starter skills keep the consumer install useful without dumping the
    // full skill catalog into the default prompt footprint.
    private static let bundledSkillAllowlist = [
        // Shared setup surface keeps first-run account/config guidance out of
        // every individual skill prompt while staying directly discoverable.
        "consumer-setup",
        "apple-notes",
        "apple-reminders",
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
    // Keep a tiny but real starter catalog on disk so the consumer picker stays
    // stable even if one provider catalog call is temporarily incomplete.
    private static let consumerSeededModels: [(ref: String, alias: String)] = [
        ("openai-codex/gpt-5.4", "GPT"),
        ("openai-codex/gpt-5.3-codex", "Codex 5.3"),
        ("anthropic/claude-sonnet-4-6", "Sonnet"),
        ("anthropic/claude-opus-4-6", "Opus"),
        ("anthropic/claude-haiku-4-5", "Haiku"),
    ]

    static func bootstrapIfNeeded() {
        self.ensureConsumerRuntimeDefaults()
        self.ensureConsumerDirectories()
        self.ensureConsumerConfig()
        self.ensureConsumerWorkspace()
    }

    private static func ensureConsumerRuntimeDefaults() {
        let defaults = UserDefaults.standard

        // Consumer location tasks depend on the mac node advertising
        // `location.get`. That command is only exposed once location mode is on,
        // so seed the first-launch defaults here instead of making testers hunt
        // for a hidden toggle in Advanced settings.
        if defaults.object(forKey: locationModeKey) == nil {
            defaults.set("whileUsing", forKey: locationModeKey)
        }
        if defaults.object(forKey: locationPreciseKey) == nil {
            defaults.set(true, forKey: locationPreciseKey)
        }
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
        changed = self.setDefaultValue(
            in: &root,
            path: ["agents", "defaults", "thinkingDefault"],
            value: "adaptive") || changed
        // Keep the allowlist/model catalog aligned with the seeded primary model so
        // runtime model resolution does not fall back to anthropic/claude-opus-4-6
        // just because the consumer config started empty.
        for seededModel in Self.consumerSeededModels {
            changed = self.setDefaultValue(
                in: &root,
                path: ["agents", "defaults", "models", seededModel.ref, "alias"],
                value: seededModel.alias) || changed
        }
        // Consumer launchd runtimes start without the user's interactive shell
        // environment, so opt into login-shell import for missing API keys.
        // This restores capability parity with fork/main without hardcoding more
        // secrets into the LaunchAgent plist.
        changed = self.setDefaultValue(
            in: &root,
            path: ["env", "shellEnv", "enabled"],
            value: true) || changed
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
        changed = self.seedBundledDefaultsIfMissing(into: &root) || changed
        // Consumer parity needs the same web capability surface as the user's
        // existing main install when it is already configured. Import only the
        // web subtree so we do not couple the consumer lane to founder auth,
        // channels, or other runtime-owned state.
        changed = self.seedLegacyWebDefaultsIfMissing(into: &root) || changed

        return changed
    }

    private static func ensureConsumerWorkspace() {
        let workspaceURL = ConsumerRuntime.workspaceURL
        guard AgentWorkspace.bootstrapSafety(for: workspaceURL).unsafeReason == nil else {
            return
        }
        _ = try? AgentWorkspace.bootstrap(workspaceURL: workspaceURL)
    }

    static func seedBundledDefaultsIfMissing(
        into root: inout [String: Any],
        bundledDefaults: [String: Any]? = nil) -> Bool
    {
        guard let defaults = bundledDefaults ?? self.loadBundledConsumerDefaults() else {
            return false
        }
        return self.mergeMissingValues(into: &root, from: defaults)
    }

    private static func seedLegacyWebDefaultsIfMissing(into root: inout [String: Any]) -> Bool {
        guard (root["tools"] as? [String: Any])?["web"] == nil else {
            return false
        }
        guard let legacyWeb = self.loadLegacyWebDefaults() else {
            return false
        }
        var tools = root["tools"] as? [String: Any] ?? [:]
        tools["web"] = legacyWeb
        root["tools"] = tools
        return true
    }

    private static func loadLegacyWebDefaults() -> [String: Any]? {
        let homePath = getenv("HOME").map { String(cString: $0) }?.trimmingCharacters(in: .whitespacesAndNewlines)
        let homeURL = homePath.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager().homeDirectoryForCurrentUser
        let url = homeURL
            .appendingPathComponent(".openclaw", isDirectory: true)
            .appendingPathComponent("openclaw.json")
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        guard
            let root = try? JSONSerialization.jsonObject(with: data, options: []),
            let dict = root as? [String: Any],
            let tools = dict["tools"] as? [String: Any],
            let web = tools["web"] as? [String: Any],
            !web.isEmpty
        else {
            return nil
        }
        return web
    }

    private static func loadBundledConsumerDefaults() -> [String: Any]? {
        guard let url = Bundle.main.url(forResource: "consumer-seeded-defaults", withExtension: "json") else {
            return nil
        }
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        guard
            let root = try? JSONSerialization.jsonObject(with: data, options: []),
            let dict = root as? [String: Any],
            !dict.isEmpty
        else {
            return nil
        }
        return dict
    }

    private static func mergeMissingValues(
        into target: inout [String: Any],
        from defaults: [String: Any]) -> Bool
    {
        var changed = false

        for (key, defaultValue) in defaults {
            if let defaultChild = defaultValue as? [String: Any] {
                if var existingChild = target[key] as? [String: Any] {
                    if self.mergeMissingValues(into: &existingChild, from: defaultChild) {
                        target[key] = existingChild
                        changed = true
                    }
                    continue
                }
                if target[key] == nil {
                    target[key] = defaultChild
                    changed = true
                }
                continue
            }

            if target[key] == nil {
                target[key] = defaultValue
                changed = true
            }
        }

        return changed
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
