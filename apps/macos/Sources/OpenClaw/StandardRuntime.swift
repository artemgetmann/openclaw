import Darwin
import Foundation

enum StandardRuntime {
    static var runtimeRootURL: URL {
        FileManager().homeDirectoryForCurrentUser
    }

    static var stateDirURL: URL {
        OpenClawPaths.canonicalStateDirURL(for: .standard)
    }

    static var configURL: URL {
        OpenClawPaths.canonicalConfigURL(for: .standard)
    }

    static var logsDirURL: URL {
        OpenClawPaths.canonicalLogsDirURL(for: .standard)
    }

    static func bootstrapProcessEnvironment() {
        // The standard app and the founder/default CLI lane are supposed to share one runtime
        // rooted at ~/.openclaw. Seed the canonical paths explicitly so the UI, shared auth
        // stores, and child CLI commands cannot silently drift into Application Support or a
        // stale consumer-root env snapshot.
        self.setEnv("OPENCLAW_APP_VARIANT", value: AppFlavor.standard.rawValue)
        self.unsetEnv("OPENCLAW_PROFILE")
        self.unsetEnv("OPENCLAW_CONSUMER_MINIMAL_STARTUP")
        self.unsetEnv("OPENCLAW_LAUNCHD_LABEL")
        self.setEnv("OPENCLAW_HOME", value: Self.runtimeRootURL.path)
        self.setEnv("OPENCLAW_STATE_DIR", value: Self.stateDirURL.path)
        self.setEnv("OPENCLAW_CONFIG_PATH", value: Self.configURL.path)
        self.setEnv("OPENCLAW_GATEWAY_PORT", value: String(AppFlavor.standard.defaultGatewayPort))
        self.setEnv("OPENCLAW_GATEWAY_BIND", value: AppFlavor.standard.defaultGatewayBind)
        self.setEnv("OPENCLAW_LOG_DIR", value: Self.logsDirURL.path)
        if let projectRoot = CommandResolver.projectRootEnvironmentHint() {
            self.setEnv("OPENCLAW_FORK_ROOT", value: projectRoot)
        }
    }

    private static func setEnv(_ key: String, value: String) {
        setenv(key, value, 1)
    }

    private static func unsetEnv(_ key: String) {
        unsetenv(key)
    }
}
