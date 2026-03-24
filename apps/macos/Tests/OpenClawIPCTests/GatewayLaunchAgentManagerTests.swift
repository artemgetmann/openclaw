import Foundation
import Testing
@testable import OpenClaw

struct GatewayLaunchAgentManagerTests {
    @Test func `launch agent plist snapshot parses args and env`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789", "--bind", "loopback"],
            "EnvironmentVariables": [
                "OPENCLAW_GATEWAY_TOKEN": " secret ",
                "OPENCLAW_GATEWAY_PASSWORD": "pw",
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.token == "secret")
        #expect(snapshot.password == "pw")
    }

    @Test func `launch agent plist snapshot allows missing bind`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
    }

    @Test func `daemon command environment pins consumer runtime paths`() async {
        await TestIsolation.withEnvValues([ConsumerInstance.envKey: nil]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: "/tmp/openclaw-worktree")

            #expect(env["OPENCLAW_PROFILE"] == ConsumerRuntime.profile)
            #expect(env["OPENCLAW_HOME"] == ConsumerRuntime.runtimeRootURL.path)
            #expect(env["OPENCLAW_STATE_DIR"] == ConsumerRuntime.stateDirURL.path)
            #expect(env["OPENCLAW_CONFIG_PATH"] == ConsumerRuntime.configURL.path)
            #expect(env["OPENCLAW_GATEWAY_PORT"] == "\(ConsumerRuntime.gatewayPort)")
            #expect(env["OPENCLAW_GATEWAY_BIND"] == ConsumerRuntime.gatewayBind)
            #expect(env["OPENCLAW_LAUNCHD_LABEL"] == gatewayLaunchdLabel)
            #expect(env["OPENCLAW_CONSUMER_MINIMAL_STARTUP"] == "1")
            #expect(env["OPENCLAW_FORK_ROOT"] == "/tmp/openclaw-worktree")
        }
    }

    @Test func `daemon command environment carries named instance identity`() async {
        await TestIsolation.withEnvValues([ConsumerInstance.envKey: "ux-audit"]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: "/tmp/openclaw-worktree")

            #expect(env[ConsumerInstance.envKey] == "ux-audit")
            #expect(env["OPENCLAW_PROFILE"] == "consumer-ux-audit")
            #expect(env["OPENCLAW_LAUNCHD_LABEL"] == "ai.openclaw.consumer.ux-audit.gateway")
            #expect(env["OPENCLAW_STATE_DIR"]?.contains("/OpenClaw Consumer/instances/ux-audit/.openclaw") == true)
        }
    }

    @Test func `preferred enable action restarts loaded service`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                launchAgentMatchesCurrentEntrypoint: true) == .restart)
    }

    @Test func `preferred enable action starts existing plist before reinstall`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: false,
                hasPlist: true,
                launchAgentMatchesCurrentEntrypoint: true) == .start)
    }

    @Test func `preferred enable action installs when service is absent`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: nil,
                hasPlist: false,
                launchAgentMatchesCurrentEntrypoint: true) == .install)
    }

    @Test func `preferred enable action reinstalls stale worktree launch agent`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                launchAgentMatchesCurrentEntrypoint: false) == .install)
    }

    @Test func `bringup treats not loaded result as not ready`() {
        #expect(
            !GatewayLaunchAgentManager._testShouldTreatBringupResultAsReady(
                """
                {"ok":true,"result":"not-loaded","message":"Gateway service not loaded.","service":{"loaded":false}}
                """))
        #expect(
            GatewayLaunchAgentManager._testShouldTreatBringupResultAsReady(
                """
                {"ok":true,"result":"started","service":{"loaded":true}}
                """))
    }
}
