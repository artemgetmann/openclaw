import Darwin
import Foundation

enum ConsumerRuntime {
    static let profile = "consumer"
    static let runtimeHomeName = "OpenClaw Consumer"
    static let gatewayPort = 19001
    static let gatewayBind = "loopback"
    static let launchdLabel = "ai.openclaw.consumer"
    static let gatewayLaunchdLabel = "ai.openclaw.consumer.gateway"

    static var runtimeRootURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/\(runtimeHomeName)", isDirectory: true)
    }

    static var stateDirURL: URL {
        self.runtimeRootURL.appendingPathComponent(".openclaw", isDirectory: true)
    }

    static var configURL: URL {
        self.stateDirURL.appendingPathComponent("openclaw.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }

    static var logsDirURL: URL {
        self.stateDirURL.appendingPathComponent("logs", isDirectory: true)
    }

    static var appLaunchAgentPlistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(self.launchdLabel).plist")
    }

    static var gatewayLaunchAgentPlistURL: URL {
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(self.gatewayLaunchdLabel).plist")
    }

    static var installPrefixURL: URL {
        self.stateDirURL
    }

    static func bootstrapProcessEnvironment() {
        // Keep the app, launch agents, and any child CLI processes pointed at the
        // consumer-owned runtime before any config/state loaders spin up.
        self.setEnv("OPENCLAW_PROFILE", value: Self.profile)
        self.setEnv("OPENCLAW_HOME", value: Self.runtimeRootURL.path)
        self.setEnv("OPENCLAW_STATE_DIR", value: Self.stateDirURL.path)
        self.setEnv("OPENCLAW_CONFIG_PATH", value: Self.configURL.path)
        self.setEnv("OPENCLAW_GATEWAY_PORT", value: String(Self.gatewayPort))
        self.setEnv("OPENCLAW_GATEWAY_BIND", value: Self.gatewayBind)
        self.setEnv("OPENCLAW_LOG_DIR", value: Self.logsDirURL.path)
        // Keep the consumer lane focused on core Telegram startup.
        // This avoids founder-oriented sidecar phases from blocking first boot.
        self.setEnv("OPENCLAW_CONSUMER_MINIMAL_STARTUP", value: "1")
        if let projectRoot = CommandResolver.projectRootEnvironmentHint() {
            // The dev mac app often shells out through the local fork wrapper in PATH.
            // Seed the worktree root explicitly so child commands do not fall back to
            // whatever founder checkout happened to export `openclaw` first.
            self.setEnv("OPENCLAW_FORK_ROOT", value: projectRoot)
        }
    }

    private static func setEnv(_ key: String, value: String) {
        setenv(key, value, 1)
    }
}
