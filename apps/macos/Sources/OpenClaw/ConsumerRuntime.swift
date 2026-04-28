import Darwin
import Foundation

enum ConsumerRuntime {
    static let imageBackend = "sips"

    private static var identity: RuntimeIdentity {
        .current
    }

    static var runtimeRootURL: URL {
        self.identity.runtimeRootURL
    }

    static var stateDirURL: URL {
        self.identity.stateDirURL
    }

    static var configURL: URL {
        self.identity.configURL
    }

    static var workspaceURL: URL {
        self.identity.workspaceURL
    }

    static var logsDirURL: URL {
        self.identity.logsDirURL
    }

    static var runtimeHomeName: String {
        ConsumerInstance.current.runtimeHomeName
    }

    static var profile: String {
        self.identity.profile ?? "default"
    }

    static var gatewayPort: Int {
        self.identity.gatewayPort
    }

    static var gatewayBind: String {
        self.identity.gatewayBind
    }

    static var launchdLabel: String {
        self.identity.appLaunchdLabel
    }

    static var gatewayLaunchdLabel: String {
        self.identity.gatewayLaunchdLabel
    }

    static var appLaunchAgentPlistURL: URL {
        OpenClawHome.currentURL
            .appendingPathComponent("Library/LaunchAgents/\(self.launchdLabel).plist")
    }

    static var gatewayLaunchAgentPlistURL: URL {
        OpenClawHome.currentURL
            .appendingPathComponent("Library/LaunchAgents/\(self.gatewayLaunchdLabel).plist")
    }

    static var installPrefixURL: URL {
        self.identity.installPrefixURL
    }

    static func bootstrapProcessEnvironment() {
        let identity = self.identity
        let instance = ConsumerInstance.current
        OpenClawPaths.migrateConsumerRuntimeIfNeeded(identity: identity, instanceID: instance.id)
        // Keep the app, launch agents, and any child CLI processes pointed at the
        // consumer-owned runtime before any config/state loaders spin up.
        self.setEnv("OPENCLAW_PROFILE", value: identity.profile ?? "default")
        self.setEnv("OPENCLAW_HOME", value: identity.runtimeRootURL.path)
        self.setEnv("OPENCLAW_STATE_DIR", value: identity.stateDirURL.path)
        self.setEnv("OPENCLAW_CONFIG_PATH", value: identity.configURL.path)
        self.setEnv("OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH", value: identity.configURL.path)
        self.setEnv("OPENCLAW_GATEWAY_PORT", value: String(identity.gatewayPort))
        self.setEnv("OPENCLAW_GATEWAY_BIND", value: identity.gatewayBind)
        self.setEnv("OPENCLAW_LOG_DIR", value: identity.logsDirURL.path)
        self.setEnv("OPENCLAW_LAUNCHD_LABEL", value: identity.gatewayLaunchdLabel)
        self.setDefaultEnv("OPENCLAW_IMAGE_BACKEND", value: self.imageBackend)
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

    private static func setDefaultEnv(_ key: String, value: String) {
        let current = ProcessInfo.processInfo.environment[key]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard current.isEmpty else { return }
        setenv(key, value, 1)
    }
}
