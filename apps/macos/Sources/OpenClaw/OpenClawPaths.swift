import Foundation
import OpenClawProtocol

enum OpenClawHome {
    static var currentURL: URL {
        if ProcessInfo.processInfo.environment["OPENCLAW_TEST"] == "1",
           let override = OpenClawEnv.path("OPENCLAW_TEST_HOME")
        {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager().homeDirectoryForCurrentUser
    }
}

enum OpenClawEnv {
    static func path(_ key: String) -> String? {
        // Normalize env overrides once so UI + file IO stay consistent.
        guard let raw = getenv(key) else { return nil }
        let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty
        else {
            return nil
        }
        return value
    }
}

enum OpenClawPaths {
    private static let configPathEnv = ["OPENCLAW_CONFIG_PATH"]
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]
    private static let runtimeMigrationDisableEnv = "OPENCLAW_DISABLE_APP_RUNTIME_MIGRATION"
    private static let telegramGroupMigrationPaths = [
        ["channels", "telegram", "groupPolicy"],
        ["channels", "telegram", "groupAllowFrom"],
        ["channels", "telegram", "groups"],
        ["channels", "telegram", "accounts", "default", "groupPolicy"],
        ["channels", "telegram", "accounts", "default", "groupAllowFrom"],
        ["channels", "telegram", "accounts", "default", "groups"],
    ]

    private static func legacyStateDirURL(home: URL) -> URL {
        home.appendingPathComponent(".openclaw", isDirectory: true)
    }

    private static func previousConsumerStateDirURL(home: URL, instanceID: String?) -> URL {
        let root = home.appendingPathComponent(
            "Library/Application Support/OpenClaw Consumer",
            isDirectory: true)
        let runtimeRoot = instanceID.map {
            root
                .appendingPathComponent("instances", isDirectory: true)
                .appendingPathComponent($0, isDirectory: true)
        } ?? root
        return runtimeRoot.appendingPathComponent(".openclaw", isDirectory: true)
    }

    private static func consumerPreferredStateDirURL(home: URL) -> URL {
        RuntimeIdentity.current.stateDirURL
    }

    static var stateDirURL: URL {
        for key in self.stateDirEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
        }
        let home = OpenClawHome.currentURL
        let legacy = self.legacyStateDirURL(home: home)
        guard AppFlavor.current.isConsumer else { return legacy }

        // Product runtime is app-owned under Application Support/OpenClaw.
        // Migration is explicit because real runtimes can be many GB; normal
        // app startup must not surprise-copy old state in the background.
        return self.consumerPreferredStateDirURL(home: home)
    }

    static func migrateConsumerRuntimeIfNeeded(
        identity: RuntimeIdentity,
        instanceID: String?,
        fileManager: FileManager = .default)
    {
        guard AppFlavor.current.isConsumer else { return }
        guard !self.runtimeMigrationDisabled() else { return }

        let destination = identity.stateDirURL
        let destinationConfig = destination.appendingPathComponent("openclaw.json")

        let home = OpenClawHome.currentURL
        for source in self.consumerMigrationSourceStateDirs(home: home, instanceID: instanceID) {
            guard source.standardizedFileURL.path != destination.standardizedFileURL.path else { continue }
            let sourceConfig = source.appendingPathComponent("openclaw.json")
            guard fileManager.fileExists(atPath: sourceConfig.path)
            else { continue }

            if fileManager.fileExists(atPath: destinationConfig.path) {
                // Existing Jarvis configs must keep their app-owned secrets,
                // gateway identity, and state paths. Only backfill the small
                // non-secret Telegram group routing fields that make migrated
                // group chats keep working.
                try? self.mergeTelegramGroupConfigIfNeeded(
                    from: sourceConfig,
                    to: destinationConfig,
                    fileManager: fileManager)
                return
            }

            // Default Jarvis intentionally starts fresh unless it already has a
            // config to merge into. Instance lanes keep the historical full
            // state copy behavior because those are explicit isolated runtimes.
            guard instanceID != nil else { return }

            do {
                try self.copyStateDirIfNeeded(from: source, to: destination, fileManager: fileManager)
            } catch {
                // Migration is best-effort by design. The app can still create a
                // fresh product runtime, and old data remains untouched for manual recovery.
            }
            return
        }
    }

    private static func mergeTelegramGroupConfigIfNeeded(
        from sourceConfig: URL,
        to destinationConfig: URL,
        fileManager: FileManager)
        throws
    {
        guard var target = self.loadJSONObject(from: destinationConfig),
              let source = self.loadJSONObject(from: sourceConfig)
        else {
            return
        }

        var changed = false
        for path in self.telegramGroupMigrationPaths {
            guard let sourceValue = self.value(in: source, path: path),
                  !self.valueIsMissing(sourceValue)
            else {
                continue
            }
            if self.valueIsMissing(self.value(in: target, path: path)) {
                // JSONSerialization may return bridged Foundation containers.
                // Round-trip the copied leaf so the target owns a clean JSON
                // value and later mutations cannot alias source dictionaries.
                changed = self.setValue(self.copyJSONValue(sourceValue), in: &target, path: path) || changed
            }
        }

        guard changed else { return }
        let data = try JSONSerialization.data(withJSONObject: target, options: [.prettyPrinted, .sortedKeys])
        try fileManager.createDirectory(
            at: destinationConfig.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try data.write(to: destinationConfig, options: [.atomic])
    }

    private static func loadJSONObject(from url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        if let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return root
        }
        let decoder = JSONDecoder()
        if #available(macOS 12.0, *) {
            decoder.allowsJSON5 = true
        }
        if let decoded = try? decoder.decode([String: AnyCodable].self, from: data) {
            return decoded.mapValues { $0.foundationValue }
        }
        return nil
    }

    private static func value(in root: [String: Any], path: [String]) -> Any? {
        guard let first = path.first else { return nil }
        if path.count == 1 {
            return root[first]
        }
        guard let child = root[first] as? [String: Any] else { return nil }
        return self.value(in: child, path: Array(path.dropFirst()))
    }

    @discardableResult
    private static func setValue(_ value: Any, in root: inout [String: Any], path: [String]) -> Bool {
        guard let first = path.first else { return false }
        if path.count == 1 {
            root[first] = value
            return true
        }

        var child = root[first] as? [String: Any] ?? [:]
        let changed = self.setValue(value, in: &child, path: Array(path.dropFirst()))
        if changed {
            root[first] = child
        }
        return changed
    }

    private static func valueIsMissing(_ value: Any?) -> Bool {
        guard let value else { return true }
        if value is NSNull { return true }
        if let string = value as? String {
            return string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if let array = value as? [Any] {
            return array.isEmpty
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.isEmpty
        }
        return false
    }

    private static func copyJSONValue(_ value: Any) -> Any {
        guard JSONSerialization.isValidJSONObject(["value": value]),
              let data = try? JSONSerialization.data(withJSONObject: ["value": value]),
              let copied = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let leaf = copied["value"]
        else {
            return value
        }
        return leaf
    }

    private static func runtimeMigrationDisabled() -> Bool {
        guard let raw = OpenClawEnv.path(self.runtimeMigrationDisableEnv)?.lowercased() else {
            return false
        }
        return ["1", "true", "yes", "on"].contains(raw)
    }

    private static func consumerMigrationSourceStateDirs(home: URL, instanceID: String?) -> [URL] {
        if instanceID != nil {
            return [
                self.previousConsumerStateDirURL(home: home, instanceID: instanceID),
            ]
        }
        return [
            self.previousConsumerStateDirURL(home: home, instanceID: nil),
            self.legacyStateDirURL(home: home),
        ]
    }

    private static func copyStateDirIfNeeded(
        from source: URL,
        to destination: URL,
        fileManager: FileManager)
        throws
    {
        if !fileManager.fileExists(atPath: destination.path) {
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try fileManager.copyItem(at: source, to: destination)
            return
        }

        guard let enumerator = fileManager.enumerator(
            at: source,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [],
            errorHandler: nil)
        else {
            return
        }

        for case let sourceChild as URL in enumerator {
            let relative = String(sourceChild.path.dropFirst(source.path.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !relative.isEmpty else { continue }

            let destinationChild = destination.appendingPathComponent(relative)
            if fileManager.fileExists(atPath: destinationChild.path) { continue }

            let values = try sourceChild.resourceValues(forKeys: [.isDirectoryKey])
            if values.isDirectory == true {
                try fileManager.createDirectory(
                    at: destinationChild,
                    withIntermediateDirectories: true)
            } else {
                try fileManager.createDirectory(
                    at: destinationChild.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                try fileManager.copyItem(at: sourceChild, to: destinationChild)
            }
        }
    }

    private static func resolveConfigCandidate(in dir: URL) -> URL? {
        let candidates = [
            dir.appendingPathComponent("openclaw.json"),
        ]
        return candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
    }

    static var configURL: URL {
        for key in self.configPathEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override)
            }
        }
        let stateDir = self.stateDirURL
        if let existing = self.resolveConfigCandidate(in: stateDir) {
            return existing
        }
        return stateDir.appendingPathComponent("openclaw.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
