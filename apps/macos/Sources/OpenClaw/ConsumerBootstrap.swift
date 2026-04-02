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
        // WhatsApp CLI is lane-local through the cleanroom wrapper, so it belongs
        // in the consumer starter set even though live WhatsApp chat is a separate
        // product surface.
        "wacli",
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

        // Older consumer bundles seeded Brave credentials under
        // tools.web.search.brave.apiKey. The config schema now expects the
        // shared search-level apiKey field, so migrate the legacy shape before
        // browser readiness or gateway startup re-reads the config.
        changed = self.migrateLegacyBraveSearchAPIKey(in: &root) || changed

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
        // Consumer setup-sensitive CLIs (for example wacli/himalaya/gog) are
        // lane-local host tools wrapped by the gateway LaunchAgent. If exec
        // falls back to the global sandbox default, those wrappers can resolve
        // against founder/global state instead of the consumer cleanroom.
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "host"],
            value: "gateway") || changed
        // The consumer lane relies on the gateway host for lane-local CLI
        // wrappers. Seed a minimal safe-bin entry so the agent can introspect
        // WhatsApp state via `wacli doctor` without dropping back to raw shell
        // approvals or the sandbox fallback path.
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "safeBins"],
            value: ["wacli", "wacli-auth-local.sh"]) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "safeBinTrustedDirs"],
            value: self.consumerCleanroomTrustedDirs()) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "safeBinProfiles", "wacli", "maxPositional"],
            value: 1) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "safeBinProfiles", "wacli-auth-local.sh", "maxPositional"],
            value: 1) || changed
        changed = self.setDefaultValue(
            in: &root,
            path: ["tools", "exec", "safeBinProfiles", "wacli-auth-local.sh", "allowedValueFlags"],
            value: [
                "--session",
                "--wait-ms",
                "--idle-exit",
                "--timeout-ms",
            ]) || changed
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
        // Append any newly curated starter skills to already-written consumer
        // configs so existing installs pick up the same baseline as fresh ones.
        changed = self.ensureBundledSkillAllowlistIncludesStarterSkills(into: &root) || changed
        changed = self.ensureExecSafeBinsIncludeStarterTools(into: &root) || changed
        changed = self.ensureExecSafeBinTrustedDirsIncludeCleanroomPrefix(into: &root) || changed
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

    private static func migrateLegacyBraveSearchAPIKey(
        in root: inout [String: Any])
        -> Bool
    {
        guard
            var tools = root["tools"] as? [String: Any],
            var web = tools["web"] as? [String: Any]
        else {
            return false
        }

        guard self.migrateLegacyBraveSearchAPIKey(inWeb: &web) else {
            return false
        }

        tools["web"] = web
        root["tools"] = tools
        return true
    }

    private static func migrateLegacyBraveSearchAPIKey(inWeb web: inout [String: Any]) -> Bool {
        guard var search = web["search"] as? [String: Any] else {
            return false
        }

        let existingAPIKey = (search["apiKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var changed = false

        if
            var brave = search["brave"] as? [String: Any],
            let legacyAPIKey = (brave["apiKey"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !legacyAPIKey.isEmpty
        {
            if existingAPIKey?.isEmpty != false {
                search["apiKey"] = legacyAPIKey
                changed = true
            }
            brave.removeValue(forKey: "apiKey")
            if brave.isEmpty {
                search.removeValue(forKey: "brave")
            } else {
                search["brave"] = brave
            }
            changed = true
        }

        guard changed else {
            return false
        }

        web["search"] = search
        return true
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
        guard var legacyWeb = self.loadLegacyWebDefaults() else {
            return false
        }
        _ = self.migrateLegacyBraveSearchAPIKey(inWeb: &legacyWeb)
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

    private static func ensureBundledSkillAllowlistIncludesStarterSkills(
        into root: inout [String: Any])
        -> Bool
    {
        guard let skills = root["skills"] as? [String: Any] else {
            return false
        }

        let existing = (skills["allowBundled"] as? [Any])?
            .compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty } ?? []
        var merged = existing
        for skill in Self.bundledSkillAllowlist where !merged.contains(skill) {
            merged.append(skill)
        }
        guard merged != existing else {
            return false
        }

        var nextSkills = skills
        nextSkills["allowBundled"] = merged
        root["skills"] = nextSkills
        return true
    }

    private static func ensureExecSafeBinsIncludeStarterTools(
        into root: inout [String: Any])
        -> Bool
    {
        guard var tools = root["tools"] as? [String: Any] else {
            return false
        }
        var exec = tools["exec"] as? [String: Any] ?? [:]
        let existingSafeBins = (exec["safeBins"] as? [Any])?
            .compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty } ?? []
        var mergedSafeBins = existingSafeBins
        if !mergedSafeBins.contains("wacli") {
            mergedSafeBins.append("wacli")
        }
        if !mergedSafeBins.contains("wacli-auth-local.sh") {
            mergedSafeBins.append("wacli-auth-local.sh")
        }

        var changed = mergedSafeBins != existingSafeBins
        if changed {
            exec["safeBins"] = mergedSafeBins
        }

        var safeBinProfiles = exec["safeBinProfiles"] as? [String: Any] ?? [:]
        if safeBinProfiles["wacli"] == nil {
            safeBinProfiles["wacli"] = ["maxPositional": 1]
            exec["safeBinProfiles"] = safeBinProfiles
            changed = true
        }
        if safeBinProfiles["wacli-auth-local.sh"] == nil {
            safeBinProfiles["wacli-auth-local.sh"] = [
                "maxPositional": 1,
                "allowedValueFlags": [
                    "--session",
                    "--wait-ms",
                    "--idle-exit",
                    "--timeout-ms",
                ],
            ]
            exec["safeBinProfiles"] = safeBinProfiles
            changed = true
        }

        guard changed else {
            return false
        }
        tools["exec"] = exec
        root["tools"] = tools
        return true
    }

    private static func consumerCleanroomTrustedDirs() -> [String] {
        let env = ProcessInfo.processInfo.environment
        let servicePrefix = env["OPENCLAW_SERVICE_PATH_PREFIX"]?
            .split(separator: ":")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty } ?? []
        return servicePrefix
    }

    private static func ensureExecSafeBinTrustedDirsIncludeCleanroomPrefix(
        into root: inout [String: Any])
        -> Bool
    {
        guard let tools = root["tools"] as? [String: Any] else {
            return false
        }
        var exec = tools["exec"] as? [String: Any] ?? [:]
        let existingTrustedDirs = (exec["safeBinTrustedDirs"] as? [Any])?
            .compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty } ?? []
        let cleanroomTrustedDirs = self.consumerCleanroomTrustedDirs()
        guard !cleanroomTrustedDirs.isEmpty else {
            return false
        }

        var mergedTrustedDirs = existingTrustedDirs
        for dir in cleanroomTrustedDirs where !mergedTrustedDirs.contains(dir) {
            mergedTrustedDirs.append(dir)
        }

        guard mergedTrustedDirs != existingTrustedDirs else {
            return false
        }

        exec["safeBinTrustedDirs"] = mergedTrustedDirs
        var nextTools = tools
        nextTools["exec"] = exec
        root["tools"] = nextTools
        return true
    }
}
