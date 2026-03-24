import Darwin
import Foundation

enum ConsumerRuntime {
    private static var instance: ConsumerInstance {
        .current
    }

    static var runtimeRootURL: URL {
        self.instance.runtimeRootURL
    }

    static var stateDirURL: URL {
        self.instance.stateDirURL
    }

    static var configURL: URL {
        self.instance.configURL
    }

    static var workspaceURL: URL {
        self.instance.workspaceURL
    }

    static var logsDirURL: URL {
        self.instance.logsDirURL
    }

    static var runtimeHomeName: String {
        self.instance.runtimeHomeName
    }

    static var profile: String {
        self.instance.profile
    }

    static var gatewayPort: Int {
        self.instance.gatewayPort
    }

    static var gatewayBind: String {
        self.instance.gatewayBind
    }

    static var launchdLabel: String {
        self.instance.appLaunchdLabel
    }

    static var gatewayLaunchdLabel: String {
        self.instance.gatewayLaunchdLabel
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
        self.instance.installPrefixURL
    }

    static func bootstrapProcessEnvironment() {
        let instance = self.instance
        // Keep the app, launch agents, and any child CLI processes pointed at the
        // consumer-owned runtime before any config/state loaders spin up.
        self.setEnv("OPENCLAW_PROFILE", value: instance.profile)
        self.setEnv("OPENCLAW_HOME", value: instance.runtimeRootURL.path)
        self.setEnv("OPENCLAW_STATE_DIR", value: instance.stateDirURL.path)
        self.setEnv("OPENCLAW_CONFIG_PATH", value: instance.configURL.path)
        self.setEnv("OPENCLAW_GATEWAY_PORT", value: String(instance.gatewayPort))
        self.setEnv("OPENCLAW_GATEWAY_BIND", value: instance.gatewayBind)
        self.setEnv("OPENCLAW_LOG_DIR", value: instance.logsDirURL.path)
        self.setEnv("OPENCLAW_LAUNCHD_LABEL", value: instance.gatewayLaunchdLabel)
        if let id = instance.id {
            self.setEnv(ConsumerInstance.envKey, value: id)
        } else {
            unsetenv(ConsumerInstance.envKey)
        }
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
