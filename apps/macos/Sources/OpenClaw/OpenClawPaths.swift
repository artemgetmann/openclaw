import Foundation

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

    private static func legacyStateDirURL(home: URL) -> URL {
        home.appendingPathComponent(AppFlavor.current.defaultStateDirName, isDirectory: true)
    }

    private static func consumerPreferredStateDirURL(home: URL) -> URL {
        home
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(AppFlavor.current.appName, isDirectory: true)
            .appendingPathComponent(".openclaw", isDirectory: true)
    }

    static var stateDirURL: URL {
        for key in self.stateDirEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
        }
        if let home = OpenClawEnv.path("OPENCLAW_HOME") {
            return URL(fileURLWithPath: home, isDirectory: true)
                .appendingPathComponent(".openclaw", isDirectory: true)
        }
        if AppFlavor.current.isConsumer {
            return ConsumerRuntime.stateDirURL
        }
        let home = FileManager().homeDirectoryForCurrentUser
        return self.legacyStateDirURL(home: home)
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
        if let existing = self.resolveConfigCandidate(in: self.stateDirURL) {
            return existing
        }
        return self.stateDirURL.appendingPathComponent("openclaw.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
