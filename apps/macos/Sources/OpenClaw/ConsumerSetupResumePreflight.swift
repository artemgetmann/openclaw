import Foundation

enum ConsumerSetupResumePreflight {
    typealias ConfigExists = () -> Bool

    @MainActor
    static func completeIfExistingSetupLooksUsable(
        defaults: UserDefaults = .standard,
        root: [String: Any] = OpenClawConfigFile.loadDict(),
        configExists: ConfigExists? = nil
    ) -> Bool {
        guard AppFlavor.current.isConsumer else { return false }
        let exists = configExists ?? {
            FileManager.default.fileExists(atPath: ConsumerRuntime.configURL.path)
        }
        guard exists() else { return false }
        guard self.hasLocalGateway(root: root) else { return false }
        guard self.hasBrowserSelection(defaults: defaults, root: root) else { return false }
        guard self.hasModelAccess(root: root) else { return false }
        guard self.hasTelegramSetup(root: root) else { return false }

        defaults.set(true, forKey: onboardingSeenKey)
        defaults.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
        return true
    }

    private static func hasLocalGateway(root: [String: Any]) -> Bool {
        let gateway = root["gateway"] as? [String: Any] ?? [:]
        let mode = (gateway["mode"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return mode.isEmpty || mode == "local"
    }

    private static func hasBrowserSelection(defaults: UserDefaults, root: [String: Any]) -> Bool {
        if let selected = defaults.string(forKey: browserSelectedChromeProfileIDKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !selected.isEmpty
        {
            return true
        }

        let browser = root["browser"] as? [String: Any] ?? [:]
        let enabled = browser["enabled"] as? Bool ?? true
        guard enabled else { return true }
        if let profile = browser["chromeProfile"] as? String {
            return !profile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
    }

    private static func hasModelAccess(root: [String: Any]) -> Bool {
        let agents = root["agents"] as? [String: Any] ?? [:]
        let defaults = agents["defaults"] as? [String: Any] ?? [:]
        if let model = ((defaults["model"] as? [String: Any])?["primary"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !model.isEmpty
        {
            return true
        }

        let auth = root["auth"] as? [String: Any] ?? [:]
        if let profiles = auth["profiles"] as? [String: Any], !profiles.isEmpty {
            return true
        }

        let models = root["models"] as? [String: Any] ?? [:]
        if let providers = models["providers"] as? [String: Any], !providers.isEmpty {
            return true
        }
        return false
    }

    private static func hasTelegramSetup(root: [String: Any]) -> Bool {
        let channels = root["channels"] as? [String: Any] ?? [:]
        let telegram = channels["telegram"] as? [String: Any] ?? [:]
        guard telegram["enabled"] as? Bool == true else { return false }
        guard let token = telegram["botToken"] as? String,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return false
        }
        if let allowed = telegram["allowFrom"] as? [Any] {
            return !allowed.isEmpty
        }
        return false
    }
}
