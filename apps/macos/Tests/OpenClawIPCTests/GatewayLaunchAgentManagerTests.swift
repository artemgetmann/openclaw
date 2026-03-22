import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
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

    @MainActor
    @Test func `daemon command environment keeps standard app on founder paths`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "standard",
            "OPENCLAW_PROFILE": "consumer",
            "OPENCLAW_HOME": "/tmp/consumer-home",
            "OPENCLAW_STATE_DIR": "/tmp/consumer-state",
            "OPENCLAW_CONFIG_PATH": "/tmp/consumer-state/openclaw.json",
            "OPENCLAW_GATEWAY_PORT": "19001",
            "OPENCLAW_GATEWAY_BIND": "loopback",
            "OPENCLAW_LOG_DIR": "/tmp/consumer-state/logs",
            "OPENCLAW_CONSUMER_MINIMAL_STARTUP": "1",
        ]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: ProcessInfo.processInfo.environment,
                projectRootHint: "/tmp/openclaw-worktree")

            let home = FileManager.default.homeDirectoryForCurrentUser.path
            #expect(env["OPENCLAW_PROFILE"] == nil)
            #expect(env["OPENCLAW_HOME"] == nil)
            #expect(env["OPENCLAW_STATE_DIR"] == "\(home)/.openclaw")
            #expect(env["OPENCLAW_CONFIG_PATH"] == "\(home)/.openclaw/openclaw.json")
            #expect(env["OPENCLAW_GATEWAY_PORT"] == "18789")
            #expect(env["OPENCLAW_GATEWAY_BIND"] == "loopback")
            #expect(env["OPENCLAW_LOG_DIR"] == "\(home)/.openclaw/logs")
            #expect(env["OPENCLAW_LAUNCHD_LABEL"] == "ai.openclaw.gateway")
            #expect(env["OPENCLAW_CONSUMER_MINIMAL_STARTUP"] == nil)
            #expect(env["OPENCLAW_FORK_ROOT"] == "/tmp/openclaw-worktree")
        }
    }

    @MainActor
    @Test func `daemon command environment keeps consumer runtime isolated`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
        ]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: "/tmp/openclaw-worktree")

            #expect(env["OPENCLAW_PROFILE"] == ConsumerRuntime.profile)
            #expect(env["OPENCLAW_HOME"] == ConsumerRuntime.runtimeRootURL.path)
            #expect(
                env["OPENCLAW_STATE_DIR"] == ConsumerRuntime.stateDirURL.path ||
                    env["OPENCLAW_STATE_DIR"] == "\(FileManager.default.homeDirectoryForCurrentUser.path)/.openclaw-consumer")
            #expect(
                env["OPENCLAW_CONFIG_PATH"] == ConsumerRuntime.configURL.path ||
                    env["OPENCLAW_CONFIG_PATH"] == "\(FileManager.default.homeDirectoryForCurrentUser.path)/.openclaw-consumer/openclaw.json")
            #expect(env["OPENCLAW_GATEWAY_PORT"] == "\(ConsumerRuntime.gatewayPort)")
            #expect(env["OPENCLAW_GATEWAY_BIND"] == ConsumerRuntime.gatewayBind)
            #expect(env["OPENCLAW_LAUNCHD_LABEL"] == gatewayLaunchdLabel)
            #expect(env["OPENCLAW_CONSUMER_MINIMAL_STARTUP"] == "1")
            #expect(env["OPENCLAW_FORK_ROOT"] == "/tmp/openclaw-worktree")
        }
    }

    @Test func `preferred enable action reuses loaded service without restart`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                matchesExpectedEntrypoint: true) == .start)
    }

    @Test func `preferred enable action starts existing plist before reinstall`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: false,
                hasPlist: true,
                matchesExpectedEntrypoint: true) == .start)
    }

    @Test func `preferred enable action installs when service is absent`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: nil,
                hasPlist: false,
                matchesExpectedEntrypoint: true) == .install)
    }

    @Test func `preferred enable action reinstalls stale plist even when loaded`() {
        #expect(
            GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                matchesExpectedEntrypoint: false) == .install)
    }
}
