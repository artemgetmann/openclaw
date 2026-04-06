import Foundation
import Testing
@testable import OpenClaw

struct LaunchAgentManagerTests {
    @Test func `launch agent environment keeps cleanroom tool isolation`() async {
        await TestIsolation.withEnvValues([
            ConsumerInstance.envKey: "user-e2e-20260402",
            "HIMALAYA_CONFIG": "/tmp/openclaw-clean/himalaya/config.toml",
            "XDG_CONFIG_HOME": "/tmp/openclaw-clean/xdg-config",
            "XDG_DATA_HOME": "/tmp/openclaw-clean/xdg-data",
            "GOG_KEYRING_PASSWORD": "openclaw-consumer-cleanroom",
            "OPENCLAW_SERVICE_PATH_PREFIX": "/tmp/openclaw-clean/bin",
        ]) {
            let env = LaunchAgentManager.launchAgentEnvironment()

            #expect(env["OPENCLAW_PROFILE"] == "consumer-user-e2e-20260402")
            #expect(env["HIMALAYA_CONFIG"] == "/tmp/openclaw-clean/himalaya/config.toml")
            #expect(env["XDG_CONFIG_HOME"] == "/tmp/openclaw-clean/xdg-config")
            #expect(env["XDG_DATA_HOME"] == "/tmp/openclaw-clean/xdg-data")
            #expect(env["GOG_KEYRING_PASSWORD"] == "openclaw-consumer-cleanroom")
            #expect(env["OPENCLAW_SERVICE_PATH_PREFIX"] == "/tmp/openclaw-clean/bin")
        }
    }

    @Test func `launch agent refresh detects stale bundle and missing cleanroom env`() async {
        await TestIsolation.withEnvValues([
            ConsumerInstance.envKey: "user-e2e-20260402",
            "HIMALAYA_CONFIG": "/tmp/openclaw-clean/himalaya/config.toml",
            "OPENCLAW_SERVICE_PATH_PREFIX": "/tmp/openclaw-clean/bin",
        ]) {
            let snapshot = LaunchAgentManager.LaunchAgentSnapshot(
                programArguments: [
                    "/tmp/other-worktree/dist/OpenClaw Consumer.app/Contents/MacOS/OpenClaw",
                ],
                environment: [
                    "OPENCLAW_PROFILE": "consumer-user-e2e-20260402",
                    "PATH": "/usr/bin:/bin",
                ])

            #expect(
                LaunchAgentManager.needsRefresh(
                    snapshot: snapshot,
                    bundlePath: "/tmp/current-worktree/dist/OpenClaw Consumer.app",
                    base: ProcessInfo.processInfo.environment))
        }
    }
}
