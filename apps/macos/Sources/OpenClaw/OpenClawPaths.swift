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

    private static func legacyStateDirURL(home: URL, flavor: AppFlavor) -> URL {
        home.appendingPathComponent(flavor.defaultStateDirName, isDirectory: true)
    }

    private static func consumerPreferredStateDirURL(home: URL, flavor: AppFlavor) -> URL {
        home
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(flavor.appName, isDirectory: true)
            .appendingPathComponent(".openclaw", isDirectory: true)
    }

    private static func defaultStateDirURL(home: URL, flavor: AppFlavor) -> URL {
        switch flavor {
        case .standard:
            // The standard macOS app shares the founder/default CLI runtime on ~/.openclaw.
            // That is the lane the main app and main bot are supposed to control together.
            return self.legacyStateDirURL(home: home, flavor: flavor)
        case .consumer:
            // Consumer moved to Application Support to avoid colliding with founder state.
            // Keep reading the older ~/.openclaw-consumer path if it already exists so local
            // tests don't silently fork themselves into a second consumer runtime root.
            let preferred = self.consumerPreferredStateDirURL(home: home, flavor: flavor)
            let legacy = self.legacyStateDirURL(home: home, flavor: flavor)
            if FileManager.default.fileExists(atPath: legacy.path) {
                return legacy
            }
            return preferred
        }
    }

    static func canonicalStateDirURL(for flavor: AppFlavor) -> URL {
        self.defaultStateDirURL(home: FileManager.default.homeDirectoryForCurrentUser, flavor: flavor)
    }

    static func canonicalConfigURL(for flavor: AppFlavor) -> URL {
        let dir = self.canonicalStateDirURL(for: flavor)
        if let existing = self.resolveConfigCandidate(in: dir) {
            return existing
        }
        return dir.appendingPathComponent("openclaw.json", isDirectory: false)
    }

    static func canonicalWorkspaceURL(for flavor: AppFlavor) -> URL {
        self.canonicalStateDirURL(for: flavor).appendingPathComponent("workspace", isDirectory: true)
    }

    static func canonicalLogsDirURL(for flavor: AppFlavor) -> URL {
        self.canonicalStateDirURL(for: flavor).appendingPathComponent("logs", isDirectory: true)
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
        return self.canonicalStateDirURL(for: AppFlavor.current)
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
        return self.stateDirURL.appendingPathComponent("openclaw.json", isDirectory: false)
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }

    static var logsDirURL: URL {
        self.stateDirURL.appendingPathComponent("logs", isDirectory: true)
    }
}
