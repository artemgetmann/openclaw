import Foundation

struct ConsumerInstance: Equatable {
    static let envKey = "OPENCLAW_CONSUMER_INSTANCE_ID"
    static let infoPlistKey = "OpenClawConsumerInstanceID"

    private static let runtimeHomeName = "OpenClaw Consumer"
    private static let defaultProfile = "consumer"
    private static let defaultGatewayPort = 19001
    private static let gatewayPortRangeStart = 20_000
    private static let gatewayPortRangeSize = 20_000

    let id: String?

    static var current: ConsumerInstance {
        self.resolve(
            environment: ProcessInfo.processInfo.environment,
            infoDictionary: Bundle.main.infoDictionary)
    }

    static func resolve(
        environment: [String: String],
        infoDictionary: [String: Any]?) -> ConsumerInstance
    {
        let envID = self.normalizedInstanceID(environment[self.envKey])
        if let envID {
            return ConsumerInstance(id: envID)
        }

        let infoID = self.normalizedInstanceID(infoDictionary?[Self.infoPlistKey] as? String)
        return ConsumerInstance(id: infoID)
    }

    var isDefault: Bool {
        self.id == nil
    }

    var runtimeHomeName: String {
        Self.runtimeHomeName
    }

    var runtimeRootURL: URL {
        let base = FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/\(Self.runtimeHomeName)", isDirectory: true)
        guard let id = self.id else {
            return base
        }
        return base
            .appendingPathComponent("instances", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
    }

    var stateDirURL: URL {
        self.runtimeRootURL.appendingPathComponent(".openclaw", isDirectory: true)
    }

    var configURL: URL {
        self.stateDirURL.appendingPathComponent("openclaw.json")
    }

    var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }

    var logsDirURL: URL {
        self.stateDirURL.appendingPathComponent("logs", isDirectory: true)
    }

    var profile: String {
        guard let id = self.id else {
            return Self.defaultProfile
        }
        // Keep a stable prefix so consumer-only heuristics still recognize instance lanes.
        return "\(Self.defaultProfile)-\(id)"
    }

    var gatewayPort: Int {
        guard let id = self.id else {
            return Self.defaultGatewayPort
        }
        return Self.gatewayPort(forNormalizedInstanceID: id)
    }

    var gatewayBind: String {
        "loopback"
    }

    var appLaunchdLabel: String {
        guard let id = self.id else {
            return "ai.openclaw.consumer"
        }
        return "ai.openclaw.consumer.\(id)"
    }

    var gatewayLaunchdLabel: String {
        guard let id = self.id else {
            return "ai.openclaw.consumer.gateway"
        }
        return "ai.openclaw.consumer.\(id).gateway"
    }

    var defaultsPrefix: String {
        guard let id = self.id else {
            return "openclaw.consumer"
        }
        return "openclaw.consumer.instances.\(id)"
    }

    var stableSuiteName: String {
        guard let id = self.id else {
            return "ai.openclaw.consumer.mac"
        }
        return "ai.openclaw.consumer.mac.\(id)"
    }

    var debugAppName: String {
        guard let id = self.id else {
            return "OpenClaw Consumer"
        }
        return "OpenClaw Consumer (\(id))"
    }

    var debugBundleIdentifier: String {
        guard let id = self.id else {
            return "ai.openclaw.consumer.mac.debug"
        }
        return "ai.openclaw.consumer.mac.debug.\(id)"
    }

    var installPrefixURL: URL {
        self.stateDirURL
    }

    static func normalizedInstanceID(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }

        var scalars: [UnicodeScalar] = []
        var previousWasDash = false
        for scalar in trimmed.unicodeScalars {
            let isLower = scalar.value >= 97 && scalar.value <= 122
            let isDigit = scalar.value >= 48 && scalar.value <= 57
            if isLower || isDigit {
                scalars.append(scalar)
                previousWasDash = false
                continue
            }
            if !previousWasDash {
                scalars.append("-")
                previousWasDash = true
            }
        }

        let normalized = String(String.UnicodeScalarView(scalars))
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return normalized.isEmpty ? nil : normalized
    }

    static func gatewayPort(forNormalizedInstanceID id: String) -> Int {
        let hash = Self.fnv1a32(id)
        return Self.gatewayPortRangeStart + Int(hash % UInt32(Self.gatewayPortRangeSize))
    }

    private static func fnv1a32(_ text: String) -> UInt32 {
        var hash: UInt32 = 0x811C9DC5
        for byte in text.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        return hash
    }
}
