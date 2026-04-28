import Foundation

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
    private static let runtimeMigrationEnv = "OPENCLAW_MIGRATE_APP_RUNTIME"

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
        guard self.runtimeMigrationRequested() else { return }

        let destination = identity.stateDirURL
        let destinationConfig = destination.appendingPathComponent("openclaw.json")
        guard !fileManager.fileExists(atPath: destinationConfig.path) else { return }

        let home = OpenClawHome.currentURL
        for source in self.consumerMigrationSourceStateDirs(home: home, instanceID: instanceID) {
            guard source.standardizedFileURL.path != destination.standardizedFileURL.path else { continue }
            guard fileManager.fileExists(atPath: source.appendingPathComponent("openclaw.json").path)
            else { continue }

            do {
                try self.copyStateDirIfNeeded(from: source, to: destination, fileManager: fileManager)
            } catch {
                // Migration is best-effort by design. The app can still create a
                // fresh product runtime, and old data remains untouched for manual recovery.
            }
            return
        }
    }

    private static func runtimeMigrationRequested() -> Bool {
        guard let raw = OpenClawEnv.path(self.runtimeMigrationEnv)?.lowercased() else {
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
            self.legacyStateDirURL(home: home),
            self.previousConsumerStateDirURL(home: home, instanceID: nil),
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
