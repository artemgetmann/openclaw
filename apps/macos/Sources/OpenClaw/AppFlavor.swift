import Foundation

enum AppFlavor: String {
    case standard
    case consumer

    static var current: AppFlavor {
        // Resolve the flavor in override order so packaging/tests can force
        // either the product default or the legacy shared-main compatibility
        // runtime without relying on final signed bundle metadata being present.
        if let env = ProcessInfo.processInfo.environment["OPENCLAW_APP_VARIANT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           let flavor = Self(rawValue: env)
        {
            return flavor
        }

        if let raw = Bundle.main.infoDictionary?["OpenClawAppVariant"] as? String,
           let flavor = Self(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        {
            return flavor
        }

        let bundleID = Bundle.main.bundleIdentifier?.lowercased() ?? ""
        if bundleID.contains(".consumer") {
            return .consumer
        }

        // Product default: one OpenClaw app with the simplified operator UX.
        // The old ~/.openclaw shared-main runtime is still available through an
        // explicit "standard" variant for dev/runtime compatibility lanes.
        return .consumer
    }

    var isConsumer: Bool {
        self == .consumer
    }

    var appName: String {
        switch self {
        case .standard:
            "OpenClaw"
        case .consumer:
            "OpenClaw"
        }
    }
}
