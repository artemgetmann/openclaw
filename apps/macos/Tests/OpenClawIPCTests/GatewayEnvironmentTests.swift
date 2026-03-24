import Foundation
import Testing
@testable import OpenClaw

struct GatewayEnvironmentTests {
    @Test func `semver parses common forms`() {
        #expect(Semver.parse("1.2.3") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("  v1.2.3  \n") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("v2.0.0") == Semver(major: 2, minor: 0, patch: 0))
        #expect(Semver.parse("3.4.5-beta.1") == Semver(major: 3, minor: 4, patch: 5)) // prerelease suffix stripped
        #expect(Semver.parse("2026.1.11-4") == Semver(major: 2026, minor: 1, patch: 11)) // build suffix stripped
        #expect(Semver.parse("1.0.5+build.123") == Semver(major: 1, minor: 0, patch: 5)) // metadata suffix stripped
        #expect(Semver.parse("v1.2.3+build.9") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.3+build.123") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.3-rc.1+build.7") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("v1.2.3-rc.1") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.0") == Semver(major: 1, minor: 2, patch: 0))
        #expect(Semver.parse(nil) == nil)
        #expect(Semver.parse("invalid") == nil)
        #expect(Semver.parse("1.2") == nil)
        #expect(Semver.parse("1.2.x") == nil)
    }

    @Test func `semver compatibility requires same major and not older`() {
        let required = Semver(major: 2, minor: 1, patch: 0)
        #expect(Semver(major: 2, minor: 1, patch: 0).compatible(with: required))
        #expect(Semver(major: 2, minor: 2, patch: 0).compatible(with: required))
        #expect(Semver(major: 2, minor: 1, patch: 1).compatible(with: required))
        #expect(Semver(major: 2, minor: 0, patch: 9).compatible(with: required) == false)
        #expect(Semver(major: 3, minor: 0, patch: 0).compatible(with: required) == false)
        #expect(Semver(major: 1, minor: 9, patch: 9).compatible(with: required) == false)
    }

    @Test func `gateway port defaults and respects env override`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_HOME": nil,
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            let defaultPort = GatewayEnvironment.gatewayPort()
            #expect(defaultPort == ConsumerRuntime.gatewayPort)
        }

        await TestIsolation.withEnvValues(["OPENCLAW_GATEWAY_PORT": "19999"]) {
            #expect(GatewayEnvironment.gatewayPort() == 19999)
        }
    }

    @Test func `consumer flavor defaults to isolated gateway port`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_HOME": nil,
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            #expect(GatewayEnvironment.gatewayPort() == 19001)
        }
    }

    @Test func `expected gateway version from string uses parser`() {
        #expect(GatewayEnvironment.expectedGatewayVersion(from: "v9.1.2") == Semver(major: 9, minor: 1, patch: 2))
        #expect(GatewayEnvironment.expectedGatewayVersion(from: "2026.1.11-4") == Semver(
            major: 2026,
            minor: 1,
            patch: 11))
        #expect(GatewayEnvironment.expectedGatewayVersion(from: nil) == nil)
    }

    @Test func `consumer lane status reports healthy consumer endpoint without global install checks`() throws {
        let status = GatewayEnvironment.describeConsumerLaneStatus(.init(
            launchdPlistExists: true,
            launchdLoaded: true,
            launchdPort: ConsumerRuntime.gatewayPort,
            endpointURL: try #require(URL(string: "ws://127.0.0.1:19001")),
            endpointHealthy: true,
            endpointFailure: nil))

        #expect(status.kind == .ok)
        #expect(status.message.contains("Consumer gateway responding"))
        #expect(status.message.contains("127.0.0.1:19001"))
    }

    @Test func `consumer lane status flags stale launchd port mismatch`() throws {
        let status = GatewayEnvironment.describeConsumerLaneStatus(.init(
            launchdPlistExists: true,
            launchdLoaded: true,
            launchdPort: 18789,
            endpointURL: try #require(URL(string: "ws://127.0.0.1:19001")),
            endpointHealthy: false,
            endpointFailure: "consumer control endpoint is not listening"))

        switch status.kind {
        case let .error(detail):
            #expect(detail.contains("18789"))
            #expect(detail.contains("19001"))
        default:
            Issue.record("Expected an explicit stale-port error for consumer launchd mismatch")
        }
        #expect(status.message == "Consumer launchd lane is targeting the wrong port.")
    }

    @Test func `consumer lane status ignores missing global install when consumer lane is absent`() throws {
        let status = GatewayEnvironment.describeConsumerLaneStatus(.init(
            launchdPlistExists: false,
            launchdLoaded: false,
            launchdPort: nil,
            endpointURL: try #require(URL(string: "ws://127.0.0.1:19001")),
            endpointHealthy: false,
            endpointFailure: "consumer control endpoint is not listening"))

        #expect(status.kind == .missingGateway)
        #expect(status.message == "Consumer gateway lane is not installed yet.")
        #expect(status.gatewayVersion == nil)
    }
}
