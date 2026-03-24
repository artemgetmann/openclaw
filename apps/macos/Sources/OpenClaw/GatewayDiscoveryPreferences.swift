import Foundation

enum GatewayDiscoveryPreferences {
    private static var preferredStableIDKey: String { consumerDefaultsKey("gateway.preferredStableID") }
    private static var legacyPreferredStableIDKey: String { consumerDefaultsKey("bridge.preferredStableID") }
    private static let globalLegacyPreferredStableIDKey = "bridge.preferredStableID"

    static func preferredStableID() -> String? {
        let defaults = UserDefaults.standard
        let raw = defaults.string(forKey: self.preferredStableIDKey)
            ?? defaults.string(forKey: self.legacyPreferredStableIDKey)
            ?? defaults.string(forKey: self.globalLegacyPreferredStableIDKey)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func setPreferredStableID(_ stableID: String?) {
        let trimmed = stableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            UserDefaults.standard.set(trimmed, forKey: self.preferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.globalLegacyPreferredStableIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: self.preferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.legacyPreferredStableIDKey)
            UserDefaults.standard.removeObject(forKey: self.globalLegacyPreferredStableIDKey)
        }
    }
}
