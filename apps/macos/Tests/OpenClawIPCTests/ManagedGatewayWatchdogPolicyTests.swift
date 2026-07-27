import Foundation
import Testing
@testable import JarvisGatewayWatchdog

struct ManagedGatewayWatchdogPolicyTests {
    private let configuration = ManagedGatewayWatchdogPolicy.Configuration(
        coldStartGrace: 180,
        failureThreshold: 4,
        recoveryBackoff: 1800,
        notificationBackoff: 21600)

    @Test func `production policy requires two minutes of consecutive failures`() {
        #expect(ManagedGatewayWatchdogPolicy.Configuration.production.failureThreshold == 8)
    }

    @Test func `normal two second restart never triggers recovery`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState()
        let start = Date(timeIntervalSince1970: 1000)

        #expect(policy.evaluate(
            observation: .running(pid: 100, healthy: true),
            now: start,
            state: &state) == .none(reason: "healthy"))
        #expect(policy.evaluate(
            observation: .unavailable(reason: "cutover"),
            now: start.addingTimeInterval(1),
            state: &state) == .none(reason: "unavailable:cutover"))
        #expect(policy.evaluate(
            observation: .running(pid: 101, healthy: true),
            now: start.addingTimeInterval(3),
            state: &state) == .none(reason: "healthy"))
        #expect(state.lastRecoveryAttemptAt == nil)
        #expect(!state.incidentActive)
    }

    @Test func `extended cold start receives full grace before failure threshold`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState()
        let start = Date(timeIntervalSince1970: 2000)

        #expect(policy.evaluate(
            observation: .running(pid: 200, healthy: false),
            now: start,
            state: &state) == .none(reason: "cold-start-grace"))
        #expect(policy.evaluate(
            observation: .running(pid: 200, healthy: false),
            now: start.addingTimeInterval(179),
            state: &state) == .none(reason: "cold-start-grace"))
        for offset in [181.0, 196.0, 211.0] {
            #expect(policy.evaluate(
                observation: .running(pid: 200, healthy: false),
                now: start.addingTimeInterval(offset),
                state: &state) == .none(reason: "bounded-health-failure"))
        }
        #expect(policy.evaluate(
            observation: .running(pid: 200, healthy: false),
            now: start.addingTimeInterval(226),
            state: &state) == .recover(pid: 200))
    }

    @Test func `alive but unresponsive process receives one bounded recovery`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState()
        let start = Date(timeIntervalSince1970: 3000)

        _ = policy.evaluate(
            observation: .running(pid: 300, healthy: true),
            now: start,
            state: &state)
        for offset in [181.0, 196.0, 211.0] {
            #expect(policy.evaluate(
                observation: .running(pid: 300, healthy: false),
                now: start.addingTimeInterval(offset),
                state: &state) == .none(reason: "bounded-health-failure"))
        }
        #expect(policy.evaluate(
            observation: .running(pid: 300, healthy: false),
            now: start.addingTimeInterval(226),
            state: &state) == .recover(pid: 300))
        #expect(state.lastRecoveryAttemptAt == start.addingTimeInterval(226))
    }

    @Test func `successful one shot recovery waits for replacement health and stays silent`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState(
            observedPID: 400,
            pidFirstObservedAt: Date(timeIntervalSince1970: 1000),
            consecutiveFailures: 3)
        let now = Date(timeIntervalSince1970: 4000)

        #expect(policy.evaluate(
            observation: .running(pid: 400, healthy: false),
            now: now,
            state: &state) == .recover(pid: 400))
        #expect(policy.recordRecoveryResult(
            succeeded: true,
            now: now,
            state: &state) == .none(reason: "awaiting-replacement-health"))
        #expect(policy.evaluate(
            observation: .running(pid: 401, healthy: true),
            now: now.addingTimeInterval(2),
            state: &state) == .none(reason: "healthy"))
        #expect(state.lastNotificationAt == nil)
        #expect(!state.incidentActive)
    }

    @Test func `failed automatic recovery creates one native incident epoch`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState(lastRecoveryAttemptAt: Date(timeIntervalSince1970: 4900))
        let now = Date(timeIntervalSince1970: 5000)

        #expect(policy.recordRecoveryResult(
            succeeded: false,
            now: now,
            state: &state) == .notify(reason: "automatic recovery failed"))
        #expect(state.incidentActive)
        #expect(policy.recordRecoveryResult(
            succeeded: false,
            now: now.addingTimeInterval(1),
            state: &state) == .none(reason: "notification-rate-limited"))
    }

    @Test func `repeated failure inside global backoff does not restart loop`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        let lastRecovery = Date(timeIntervalSince1970: 6000)
        var state = ManagedGatewayWatchdogState(
            observedPID: 501,
            pidFirstObservedAt: Date(timeIntervalSince1970: 5000),
            consecutiveFailures: 3,
            lastRecoveryAttemptAt: lastRecovery)
        let now = lastRecovery.addingTimeInterval(120)

        #expect(policy.evaluate(
            observation: .running(pid: 501, healthy: false),
            now: now,
            state: &state) == .notify(reason: "automatic recovery is rate-limited"))
        #expect(state.lastRecoveryAttemptAt == lastRecovery)
        #expect(state.incidentActive)
    }

    @Test func `deliberate stop and release suppression reset the failure epoch`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState(
            observedPID: 600,
            pidFirstObservedAt: Date(timeIntervalSince1970: 1000),
            consecutiveFailures: 3)
        let now = Date(timeIntervalSince1970: 7000)

        #expect(policy.evaluate(
            observation: .suppressed(reason: "release-lock"),
            now: now,
            state: &state) == .none(reason: "suppressed:release-lock"))
        #expect(state.observedPID == nil)
        #expect(state.consecutiveFailures == 0)
        #expect(policy.evaluate(
            observation: .running(pid: 600, healthy: false),
            now: now.addingTimeInterval(1),
            state: &state) == .none(reason: "cold-start-grace"))

        #expect(policy.evaluate(
            observation: .unavailable(reason: "gateway-not-running"),
            now: now.addingTimeInterval(2),
            state: &state) == .none(reason: "unavailable:gateway-not-running"))
        #expect(state.lastRecoveryAttemptAt == nil)
    }

    @Test func `wrong runtime ownership never grants recovery authority`() {
        var policy = ManagedGatewayWatchdogPolicy(configuration: self.configuration)
        var state = ManagedGatewayWatchdogState(
            observedPID: 700,
            pidFirstObservedAt: Date(timeIntervalSince1970: 1000),
            consecutiveFailures: 99)
        let action = policy.evaluate(
            observation: .wrongOwnership(reason: "source-checkout"),
            now: Date(timeIntervalSince1970: 8000),
            state: &state)

        #expect(action == .none(reason: "wrong-ownership:source-checkout"))
        #expect(state.observedPID == nil)
        #expect(state.lastRecoveryAttemptAt == nil)
    }

    @Test func `environment accepts only exact default Jarvis and rejects isolated profiles`() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-watchdog-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let stateDir = home.appendingPathComponent(
            "Library/Application Support/Jarvis/.jarvis",
            isDirectory: true)
        let base = [
            "HOME": home.path,
            "OPENCLAW_PROFILE": "consumer",
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": stateDir.appendingPathComponent("openclaw.json").path,
            "OPENCLAW_GATEWAY_PORT": "18789",
            "OPENCLAW_LAUNCHD_LABEL": "ai.jarvis.gateway",
        ]

        let resolved = try ManagedGatewayWatchdogEnvironment.resolve(
            processEnvironment: base,
            uid: 501)
        #expect(resolved.launchdLabel == "ai.jarvis.gateway")
        #expect(resolved.releaseLockURL.path.contains("openclaw-jarvis-release-locks-501"))

        var isolated = base
        isolated["OPENCLAW_PROFILE"] = "consumer-tester"
        isolated["OPENCLAW_CONSUMER_INSTANCE_ID"] = "tester"
        #expect(throws: ManagedGatewayWatchdogError.self) {
            _ = try ManagedGatewayWatchdogEnvironment.resolve(
                processEnvironment: isolated,
                uid: 501)
        }
    }

    @Test func `ownership accepts Application Support and rejects source checkout`() throws {
        let fileManager = FileManager.default
        let home = fileManager.temporaryDirectory
            .appendingPathComponent("jarvis-watchdog-plist-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: home) }
        let stateDir = home.appendingPathComponent(
            "Library/Application Support/Jarvis/.jarvis",
            isDirectory: true)
        let environment = try ManagedGatewayWatchdogEnvironment.resolve(
            processEnvironment: [
                "HOME": home.path,
                "OPENCLAW_PROFILE": "consumer",
                "OPENCLAW_STATE_DIR": stateDir.path,
                "OPENCLAW_CONFIG_PATH": stateDir.appendingPathComponent("openclaw.json").path,
                "OPENCLAW_GATEWAY_PORT": "18789",
                "OPENCLAW_LAUNCHD_LABEL": "ai.jarvis.gateway",
            ])
        try fileManager.createDirectory(
            at: environment.gatewayPlistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)

        func writePlist(command: String) throws {
            let object: [String: Any] = [
                "Label": "ai.jarvis.gateway",
                "ProgramArguments": ["/usr/bin/node", command],
                "EnvironmentVariables": [
                    "OPENCLAW_PROFILE": "consumer",
                    "OPENCLAW_STATE_DIR": stateDir.path,
                    "OPENCLAW_CONFIG_PATH": stateDir.appendingPathComponent("openclaw.json").path,
                    "OPENCLAW_GATEWAY_PORT": "18789",
                    "OPENCLAW_LAUNCHD_LABEL": "ai.jarvis.gateway",
                ],
            ]
            let data = try PropertyListSerialization.data(
                fromPropertyList: object,
                format: .xml,
                options: 0)
            try data.write(to: environment.gatewayPlistURL, options: .atomic)
        }

        try writePlist(command: stateDir
            .appendingPathComponent("lib/openclaw-bundled/openclaw/dist/index.js").path)
        if case let .failure(error) = environment.validateGatewayOwnership() {
            Issue.record("expected exact app-support ownership, got \(error)")
        }

        try writePlist(command: "/Users/user/Programming_Projects/openclaw/dist/index.js")
        if case .success = environment.validateGatewayOwnership() {
            Issue.record("source checkout must never receive Jarvis recovery authority")
        }
    }

    @Test func `launchd parser requires running state and positive pid`() {
        #expect(ManagedGatewayJobSnapshot.parse("""
        gui/501/ai.jarvis.gateway = {
            state = running
            pid = 4242
        }
        """) == ManagedGatewayJobSnapshot(pid: 4242))
        #expect(ManagedGatewayJobSnapshot.parse("state = waiting\npid = 4242") == nil)
        #expect(ManagedGatewayJobSnapshot.parse("state = running\npid = 0") == nil)
    }
}
