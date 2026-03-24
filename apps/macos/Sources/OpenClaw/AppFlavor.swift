import Foundation

enum AppFlavor: String {
    case standard
    case consumer

    static var current: AppFlavor {
        // Resolve the flavor in override order so packaging/tests can force consumer mode
        // without relying on the final signed bundle metadata being present.
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

        return .standard
    }

    var isConsumer: Bool {
        self == .consumer
    }

    var appName: String {
        if let raw = Bundle.main.infoDictionary?["CFBundleDisplayName"] as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return switch self {
        case .standard:
            "OpenClaw"
        case .consumer:
            ConsumerInstance.current.debugAppName
        }
    }

    var defaultsPrefix: String {
        switch self {
        case .standard:
            "openclaw"
        case .consumer:
            ConsumerInstance.current.defaultsPrefix
        }
    }

    var stableSuiteName: String {
        switch self {
        case .standard:
            "ai.openclaw.mac"
        case .consumer:
            ConsumerInstance.current.stableSuiteName
        }
    }

    var gatewayLaunchLabel: String {
        switch self {
        case .standard:
            "ai.openclaw.gateway"
        case .consumer:
            ConsumerInstance.current.gatewayLaunchdLabel
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
            ConsumerInstance.current.gatewayPort
        }
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
