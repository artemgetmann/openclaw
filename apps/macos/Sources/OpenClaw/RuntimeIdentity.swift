import Foundation

struct RuntimeIdentity: Equatable {
    let appName: String
    let defaultsPrefix: String
    let stableSuiteName: String
    let appLaunchdLabel: String
    let gatewayLaunchdLabel: String
    let runtimeRootURL: URL
    let stateDirURL: URL
    let configURL: URL
    let workspaceURL: URL
    let logsDirURL: URL
    let installPrefixURL: URL
    let profile: String?
    let gatewayPort: Int
    let gatewayBind: String
    let defaultLogDirName: String

    static var current: RuntimeIdentity {
        switch AppFlavor.current {
        case .standard:
            self.standard
        case .consumer:
            ConsumerInstance.current.runtimeIdentity
        }
    }

    private static var standard: RuntimeIdentity {
        let home = OpenClawHome.currentURL
        let stateDir = home.appendingPathComponent(".openclaw", isDirectory: true)
        return RuntimeIdentity(
            appName: "OpenClaw",
            defaultsPrefix: "openclaw",
            stableSuiteName: "ai.openclaw.mac",
            appLaunchdLabel: "ai.openclaw",
            gatewayLaunchdLabel: "ai.openclaw.gateway",
            runtimeRootURL: home,
            stateDirURL: stateDir,
            configURL: stateDir.appendingPathComponent("openclaw.json"),
            workspaceURL: stateDir.appendingPathComponent("workspace", isDirectory: true),
            logsDirURL: stateDir.appendingPathComponent("logs", isDirectory: true),
            installPrefixURL: stateDir,
            profile: nil,
            gatewayPort: 18_789,
            gatewayBind: "loopback",
            defaultLogDirName: "openclaw")
    }
}
