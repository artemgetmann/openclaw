import Darwin
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

    @Test func `restart or start preserves existing launch agent install`() async {
        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = await GatewayLaunchAgentManager.restartOrStart(
            bundlePath: "/Applications/OpenClaw.app",
            port: 18789)

        #expect(error == nil)
        #expect(calls == [["restart"]])
    }

    @Test func `restart or start installs only when no launch agent exists`() async {
        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { false },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = await GatewayLaunchAgentManager.restartOrStart(
            bundlePath: "/Applications/OpenClaw.app",
            port: 18789)

        #expect(error == nil)
        #expect(calls == [["install", "--force", "--allow-shared-service-takeover", "--port", "18789", "--runtime", "node"]])
    }

    @Test func `real launchd install stays pinned to canonical repo and restart preserves entrypoint`() async throws {
        #if os(macOS)
        guard await self.canRunLaunchdIntegration() else { return }

        let label = "ai.openclaw.gateway-int-\(UUID().uuidString.prefix(8))"
        let stateDir = try makeTempDirForTests()
        defer { try? FileManager().removeItem(at: stateDir) }

        let repoRoot = self.repoRoot()
        let canonicalRoot = CommandResolver.canonicalGatewayProjectRoot(projectRoot: repoRoot)
        let expectedEntrypoint = try #require(CommandResolver.gatewayEntrypoint(in: canonicalRoot))
        let port = Int.random(in: 22000..<32000)
        let plistURL = FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
        let bundlePath = "/Applications/OpenClaw.app"
        let configPath = stateDir.appendingPathComponent("openclaw.json").path
        try """
        {
          "gateway": {
            "mode": "local"
          }
        }
        """.write(toFile: configPath, atomically: true, encoding: .utf8)

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_LAUNCHD_LABEL": label,
                "OPENCLAW_STATE_DIR": stateDir.path,
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_PORT": "\(port)",
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": repoRoot.path,
            ]
        ) {
            // Clean up any stale throwaway label first so the assertions only observe
            // the install/restart triggered by this test body.
            _ = await GatewayLaunchAgentManager.set(enabled: false, bundlePath: bundlePath, port: port)
            do {
                let installError = await GatewayLaunchAgentManager.set(
                    enabled: true,
                    bundlePath: bundlePath,
                    port: port)
                #expect(installError == nil)

                let before = try await self.waitForLaunchAgentSnapshot(at: plistURL)
                #expect(before.programArguments.count >= 3)
                if before.programArguments.count >= 3 {
                    #expect(before.programArguments[1] == expectedEntrypoint)
                    #expect(before.programArguments[2] == "gateway")
                }

                let beforePid = try await self.waitForRunningLaunchdPid(label: label)
                let restartError = await GatewayLaunchAgentManager.restartOrStart(
                    bundlePath: bundlePath,
                    port: port)
                #expect(restartError == nil)

                let after = try await self.waitForLaunchAgentSnapshot(at: plistURL)
                #expect(after.programArguments == before.programArguments)

                let afterPid = try await self.waitForRunningLaunchdPid(label: label, pidNot: beforePid)
                #expect(afterPid != beforePid)
            } catch {
                _ = await GatewayLaunchAgentManager.set(enabled: false, bundlePath: bundlePath, port: port)
                throw error
            }

            let uninstallError = await GatewayLaunchAgentManager.set(
                enabled: false,
                bundlePath: bundlePath,
                port: port)
            #expect(uninstallError == nil)
        }
        #endif
    }
}

extension GatewayLaunchAgentManagerTests {
    private func repoRoot(filePath: StaticString = #filePath) -> URL {
        let fileURL = URL(fileURLWithPath: "\(filePath)")
        return fileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func canRunLaunchdIntegration() async -> Bool {
        let domain = "gui/\(getuid())"
        let probe = await Launchctl.run(["print", domain])
        return probe.status == 0
    }

    private func waitForLaunchAgentSnapshot(
        at url: URL,
        timeoutSeconds: Double = 30) async throws -> LaunchAgentPlistSnapshot
    {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let snapshot = LaunchAgentPlist.snapshot(url: url) {
                return snapshot
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        Issue.record("Timed out waiting for launch agent plist at \(url.path)")
        throw CancellationError()
    }

    private func waitForRunningLaunchdPid(
        label: String,
        pidNot: Int? = nil,
        timeoutSeconds: Double = 30) async throws -> Int
    {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let pid = await self.launchdPid(label: label), pid > 1, pid != pidNot {
                return pid
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        Issue.record("Timed out waiting for running launchd pid for \(label)")
        throw CancellationError()
    }

    private func launchdPid(label: String) async -> Int? {
        let target = "gui/\(getuid())/\(label)"
        let result = await Launchctl.run(["print", target])
        guard result.status == 0 else { return nil }

        for rawLine in result.output.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.contains("pid = ") else { continue }
            let nsLine = line as NSString
            let range = NSRange(location: 0, length: nsLine.length)
            let regex = try? NSRegularExpression(pattern: #"pid = ([0-9]+)"#)
            guard
                let regex,
                let match = regex.firstMatch(in: line, options: [], range: range),
                match.numberOfRanges == 2
            else {
                continue
            }
            let pidString = nsLine.substring(with: match.range(at: 1))
            return Int(pidString)
        }
        return nil
    }
}
