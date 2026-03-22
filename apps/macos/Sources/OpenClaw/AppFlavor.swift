import Foundation

enum AppFlavor: String {
    case standard
    case consumer

    private static func parse(_ raw: String?) -> AppFlavor? {
        guard let raw else { return nil }
        return Self(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    static func resolve(
        environment: [String: String],
        infoDictionary: [String: Any]?,
        bundleIdentifier: String?,
        bundleURL: URL?
    ) -> AppFlavor {
        let envFlavor = self.parse(environment["OPENCLAW_APP_VARIANT"])
        let infoFlavor = self.parse(infoDictionary?["OpenClawAppVariant"] as? String)
        let bundleFlavor: AppFlavor?
        if let bundleIdentifier {
            bundleFlavor = bundleIdentifier.lowercased().contains(".consumer") ? .consumer : nil
        } else {
            bundleFlavor = nil
        }
        let isBundledApp = bundleURL?.pathExtension.lowercased() == "app"

        if isBundledApp {
            // A real signed app bundle should trust its own metadata before ambient shell env.
            // Otherwise a stale consumer override can make the standard app bootstrap the wrong
            // runtime before it gets a chance to clean the process environment.
            return infoFlavor ?? bundleFlavor ?? envFlavor ?? .standard
        }

        // Tests and non-bundled tooling still need the env override so we can force a flavor
        // without having to forge app bundle metadata in-process.
        return envFlavor ?? infoFlavor ?? bundleFlavor ?? .standard
    }

    static var current: AppFlavor {
        self.resolve(
            environment: ProcessInfo.processInfo.environment,
            infoDictionary: Bundle.main.infoDictionary,
            bundleIdentifier: Bundle.main.bundleIdentifier,
            bundleURL: Bundle.main.bundleURL)
    }

    var isConsumer: Bool {
        self == .consumer
    }

    var appName: String {
        switch self {
        case .standard:
            "OpenClaw"
        case .consumer:
            "OpenClaw Consumer"
        }
    }

    var defaultsPrefix: String {
        switch self {
        case .standard:
            "openclaw"
        case .consumer:
            "openclaw.consumer"
        }
    }

    var stableSuiteName: String {
        switch self {
        case .standard:
            "ai.openclaw.mac"
        case .consumer:
            "ai.openclaw.consumer.mac"
        }
    }

    var appLaunchLabel: String {
        switch self {
        case .standard:
            "ai.openclaw"
        case .consumer:
            "ai.openclaw.consumer"
        }
    }

    var gatewayLaunchLabel: String {
        switch self {
        case .standard:
            "ai.openclaw.gateway"
        case .consumer:
            "ai.openclaw.consumer.gateway"
        }
    }

    var defaultStateDirName: String {
        switch self {
        case .standard:
            ".openclaw"
        case .consumer:
            ".openclaw-consumer"
        }
    }

    var defaultGatewayPort: Int {
        switch self {
        case .standard:
            18789
        case .consumer:
            19001
        }
    }

    var defaultGatewayBind: String {
        "loopback"
    }

    var defaultLogDirName: String {
        switch self {
        case .standard:
            "openclaw"
        case .consumer:
            "openclaw-consumer"
        }
    }

    var telegramSetupGuideURL: String? {
        switch self {
        case .standard:
            nil
        case .consumer:
            "https://docs.openclaw.ai/channels/telegram"
        }
    }

    var telegramSetupVideoURL: String? {
        switch self {
        case .standard:
            nil
        case .consumer:
            self.consumerTelegramSetupVideoURLOverride
        }
    }

    private var consumerTelegramSetupVideoURLOverride: String? {
        let env = ProcessInfo.processInfo.environment["OPENCLAW_CONSUMER_TELEGRAM_VIDEO_URL"]
        if let env {
            let trimmed = env.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        if let raw = Bundle.main.infoDictionary?["OpenClawConsumerTelegramVideoURL"] as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return nil
    }
}
