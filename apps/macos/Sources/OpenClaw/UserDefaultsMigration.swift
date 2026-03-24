import Foundation

private let legacyDefaultsPrefix = "openclaw."

func migrateLegacyDefaults() {
    // Instance-scoped consumer lanes must stay hermetic. Importing the default
    // consumer/founder defaults into a named instance would defeat the point of
    // deterministic isolation, so only the legacy default lane migrates.
    guard ConsumerInstance.current.isDefault else { return }

    let defaults = UserDefaults.standard
    let snapshot = defaults.dictionaryRepresentation()
    let newPrefix = AppFlavor.current.defaultsPrefix + "."
    for (key, value) in snapshot where key.hasPrefix(legacyDefaultsPrefix) {
        let suffix = key.dropFirst(legacyDefaultsPrefix.count)
        let newKey = newPrefix + suffix
        if defaults.object(forKey: newKey) == nil {
            defaults.set(value, forKey: newKey)
        }
    }
}
