import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
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

    @Test func `gateway port defaults and respects override`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_APP_VARIANT": "standard",
                "OPENCLAW_GATEWAY_PORT": nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            let defaultPort = GatewayEnvironment.gatewayPort()
            #expect(defaultPort == 18789)

            UserDefaults.standard.set(19999, forKey: "gatewayPort")
            defer { UserDefaults.standard.removeObject(forKey: "gatewayPort") }
            #expect(GatewayEnvironment.gatewayPort() == 19999)
        }
    }

    @Test func `consumer flavor defaults to canonical gateway port`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_GATEWAY_PORT": nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            #expect(GatewayEnvironment.gatewayPort() == 18789)
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

    @Test func `packaged consumer resolves bundled runtime despite stale source package version`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }

        try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": homeURL.path,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_HOME": nil,
                "OPENCLAW_FORK_ROOT": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_GATEWAY_BIND": nil,
                "OPENCLAW_LOG_DIR": nil,
                "OPENCLAW_LAUNCHD_LABEL": nil,
            ],
            defaults: [
                "gatewayPort": nil,
                "openclaw.gatewayProjectRootPath": nil,
            ])
        {
            GatewayEnvironment._setTestingExpectedGatewayVersionString("2026.3.23")
            defer { GatewayEnvironment._clearTestingHooks() }

            let fm = FileManager.default
            let installPrefix = ConsumerRuntime.installPrefixURL
            let bundledRoot = ConsumerBundledRuntime.installedProjectRoot()
            let distEntry = bundledRoot.appendingPathComponent("dist/index.js")
            try fm.createDirectory(at: distEntry.deletingLastPathComponent(), withIntermediateDirectories: true)
            try """
            {
              "name": "openclaw",
              "version": "2026.3.16"
            }
            """.write(to: bundledRoot.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
            try "export {}\n".write(to: bundledRoot.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
            try "export {}\n".write(to: distEntry, atomically: true, encoding: .utf8)

            // Model the installed packaged runtime: app-owned Node plus a stale
            // wrapper whose package semver does not match the Sparkle app semver.
            let nodePath = installPrefix.appendingPathComponent("tools/node/bin/node")
            try self.writeExecutableScript(
                at: nodePath,
                contents: """
                #!/bin/sh
                echo v22.16.0
                """)

            let staleWrapper = installPrefix.appendingPathComponent("bin/openclaw")
            try self.writeExecutableScript(
                at: staleWrapper,
                contents: """
                #!/bin/sh
                if [ "$1" = "--version" ]; then
                  echo "OpenClaw 2026.3.16"
                  exit 0
                fi
                echo stale-wrapper
                """)

            let status = GatewayEnvironment.check()
            guard case .ok = status.kind else {
                Issue.record("Expected bundled consumer runtime to pass, got \(status.kind): \(status.message)")
                return
            }
            #expect(status.gatewayVersion == "2026.3.16")
            #expect(status.requiredGateway == "2026.3.23")
            #expect(status.message.contains("bundled"))

            let resolution = GatewayEnvironment.resolveGatewayCommand()
            guard case .ok = resolution.status.kind else {
                Issue.record("Expected bundled consumer command to resolve, got \(resolution.status.kind)")
                return
            }
            let command = try #require(resolution.command)
            #expect(command.count >= 3)
            #expect(command[0] == nodePath.path)
            #expect(command[1] == distEntry.path)
            #expect(command[2] == "gateway-daemon")
            #expect(command.contains(staleWrapper.path) == false)
        }
    }

    private func writeExecutableScript(at url: URL, contents: String) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
}
