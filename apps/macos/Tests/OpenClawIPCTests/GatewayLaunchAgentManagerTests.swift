import Darwin
import Foundation
import OpenClawKit
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

    @Test func `enable reinstalls loaded launch agent when service version is stale`() {
        #expect(GatewayLaunchAgentManager._testDesiredEnableAction(
            loaded: true,
            hasPlist: true,
            launchAgentMatchesCurrentServiceVersion: false) == .install)
    }

    @Test func `service identity requires matching version and build when version marker exists`() throws {
        let currentVersion = "2026.3.22"
        let currentBuild = "2026061103"
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion(currentVersion)
        GatewayLaunchAgentManager._setTestingCurrentServiceBuild(currentBuild)
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let matching = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: [
                "OPENCLAW_SERVICE_VERSION": currentVersion,
                "OPENCLAW_SERVICE_BUILD": currentBuild,
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil)
        let missingBuild = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: [
                "OPENCLAW_SERVICE_VERSION": currentVersion,
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil)
        let staleBuild = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: [
                "OPENCLAW_SERVICE_VERSION": currentVersion,
                "OPENCLAW_SERVICE_BUILD": "\(currentBuild)-stale",
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: nil,
            password: nil)

        #expect(GatewayLaunchAgentManager.launchAgentMatchesCurrentServiceVersion(snapshot: matching))
        #expect(!GatewayLaunchAgentManager.launchAgentMatchesCurrentServiceVersion(snapshot: missingBuild))
        #expect(!GatewayLaunchAgentManager.launchAgentMatchesCurrentServiceVersion(snapshot: staleBuild))
    }

    @Test func `restart reinstalls loaded launch agent when service version or runtime is stale`() {
        #expect(GatewayLaunchAgentManager._testDesiredRestartAction(
            loaded: true,
            hasPlist: true,
            launchAgentMatchesCurrentServiceVersion: false) == .install)
        #expect(GatewayLaunchAgentManager._testDesiredRestartAction(
            loaded: true,
            hasPlist: true,
            launchAgentMatchesCurrentRuntime: false) == .install)
    }

    @MainActor
    @Test func `default consumer treats missing launchd service identity as stale`() async throws {
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion("2026.3.18")
        GatewayLaunchAgentManager._setTestingCurrentServiceBuild("2026061001")
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let identity = RuntimeIdentity.current
            let snapshot = LaunchAgentPlistSnapshot(
                programArguments: [],
                environment: [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
                stdoutPath: nil,
                stderrPath: nil,
                port: identity.gatewayPort,
                bind: identity.gatewayBind,
                token: nil,
                password: nil)

            #expect(!GatewayLaunchAgentManager.launchAgentMatchesCurrentServiceVersion(snapshot: snapshot))
            #expect(GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                launchAgentMatchesCurrentRuntime: true,
                launchAgentMatchesCurrentEntrypoint: true,
                launchAgentMatchesCurrentServiceVersion: false) == .install)
        }
    }

    @MainActor
    @Test func `installed app build rejects stale source checkout launch agent`() async throws {
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion("2026.3.18")
        GatewayLaunchAgentManager._setTestingCurrentServiceBuild("2026061001")
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let installedRoot = try self.makeRepoRoot(named: "Application Support/OpenClaw/.openclaw/lib/openclaw-bundled")
        let sourceRoot = try self.makeRepoRoot(named: "source-openclaw-\(UUID().uuidString)")
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: installedRoot)
            try? FileManager().removeItem(at: sourceRoot)
        }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": installedRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let sourceEntrypoint = sourceRoot.appendingPathComponent("dist/index.js").path
            let snapshot = LaunchAgentPlistSnapshot(
                programArguments: ["/usr/bin/node", sourceEntrypoint, "gateway"],
                environment: [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_SERVICE_VERSION": "2026.3.16",
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
                stdoutPath: nil,
                stderrPath: nil,
                port: identity.gatewayPort,
                bind: identity.gatewayBind,
                token: nil,
                password: nil)

            let ownership = GatewayLaunchAgentManager.currentEntrypointOwnership(snapshot: snapshot)

            #expect(ownership.expectedEntrypoint == installedRoot.appendingPathComponent("dist/index.js").path)
            #expect(ownership.actualEntrypoint == sourceEntrypoint)
            #expect(!ownership.matchesCurrentEntrypoint)
            #expect(!GatewayLaunchAgentManager.launchAgentMatchesCurrentServiceVersion(snapshot: snapshot))
            #expect(GatewayLaunchAgentManager._testDesiredEnableAction(
                loaded: true,
                hasPlist: true,
                launchAgentMatchesCurrentRuntime: true,
                launchAgentMatchesCurrentEntrypoint: ownership.matchesCurrentEntrypoint,
                launchAgentMatchesCurrentServiceVersion: false) == .install)
        }
    }

    @MainActor
    @Test func `packaged consumer ownership expects bundled runtime over stale source default`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let bundled = try self.makeBundledRuntime()
        let staleSourceRoot = try self.makeRepoRoot(named: "source-openclaw-\(UUID().uuidString)")
        defer {
            ConsumerBundledRuntime._clearTestingResourceURL()
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: bundled.resourceRoot.deletingLastPathComponent())
            try? FileManager().removeItem(at: staleSourceRoot)
        }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": staleSourceRoot.path,
            ])
        {
            ConsumerBundledRuntime._setTestingResourceURL(bundled.resourceRoot)
            let seededRoot = ConsumerBundledRuntime.installedProjectRoot()
            _ = try self.makeRepoRoot(at: seededRoot)
            let sourceEntrypoint = staleSourceRoot.appendingPathComponent("dist/index.js").path
            let snapshot = LaunchAgentPlistSnapshot(
                programArguments: ["/usr/bin/node", sourceEntrypoint, "gateway"],
                environment: [:],
                stdoutPath: nil,
                stderrPath: nil,
                port: nil,
                bind: nil,
                token: nil,
                password: nil)

            let ownership = GatewayLaunchAgentManager.currentEntrypointOwnership(snapshot: snapshot)

            #expect(ownership.expectedEntrypoint == seededRoot.appendingPathComponent("dist/index.js").path)
            #expect(ownership.actualEntrypoint == sourceEntrypoint)
            #expect(!ownership.matchesCurrentEntrypoint)
        }
    }

    @MainActor
    @Test func `daemon command environment prefers seeded bundled runtime over bundle resources`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let sourceRoot = try self.makeRepoRoot(named: "source-openclaw-\(UUID().uuidString)")
        let worktreeBundle = try self.makeBundledRuntime()
        let fm = FileManager.default
        let manifest = ConsumerBundledRuntime.Manifest(
            format: 1,
            bundleVersion: "123",
            gitCommit: "abc123",
            nodeVersion: "22.22.1",
            uvVersion: "0.9.21")
        try BundledRuntimeFixtureHelper.writeMinimalBundledRuntime(
            into: worktreeBundle.resourceRoot,
            manifest: manifest,
            fileManager: fm)
        try self.writeBundledWorkspaceTemplates(into: worktreeBundle.projectRoot)
        defer {
            ConsumerBundledRuntime._clearTestingResourceURL()
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: sourceRoot)
            try? FileManager().removeItem(at: worktreeBundle.resourceRoot.deletingLastPathComponent())
        }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": sourceRoot.path,
            ])
        {
            ConsumerBundledRuntime._setTestingResourceURL(worktreeBundle.resourceRoot)
            ConsumerBundledRuntime.bootstrapIfNeeded(fileManager: fm)
            let seededRoot = ConsumerBundledRuntime.installedProjectRoot()
            let seededEntrypoint = seededRoot.appendingPathComponent("dist/index.js").path
            let resourceEntrypoint = worktreeBundle.projectRoot.appendingPathComponent("dist/index.js").path
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(base: [:])
            let snapshot = LaunchAgentPlistSnapshot(
                programArguments: ["/usr/bin/node", resourceEntrypoint, "gateway"],
                environment: [:],
                stdoutPath: nil,
                stderrPath: nil,
                port: nil,
                bind: nil,
                token: nil,
                password: nil)
            let ownership = GatewayLaunchAgentManager.currentEntrypointOwnership(snapshot: snapshot)

            #expect(CommandResolver.daemonProjectRootEnvironmentHint() == seededRoot.path)
            #expect(CommandResolver.canonicalGatewayProjectRoot().path == seededRoot.path)
            #expect(GatewayLaunchAgentManager._testDaemonCommandProjectRoot().path == seededRoot.path)
            #expect(env["OPENCLAW_FORK_ROOT"] == seededRoot.path)
            #expect(env["OPENCLAW_FORK_ROOT"] != sourceRoot.path)
            #expect(ownership.expectedEntrypoint == seededEntrypoint)
            #expect(ownership.actualEntrypoint == resourceEntrypoint)
            #expect(!ownership.matchesCurrentEntrypoint)
        }
    }

    @MainActor
    @Test func `enable installs when packaged app finds source checkout entrypoint`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let bundled = try self.makeBundledRuntime()
        let staleSourceRoot = try self.makeRepoRoot(named: "source-openclaw-\(UUID().uuidString)")
        let plistURL = home
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.gateway.plist")
        defer {
            ConsumerBundledRuntime._clearTestingResourceURL()
            GatewayLaunchAgentManager._clearTestingHooks()
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: bundled.resourceRoot.deletingLastPathComponent())
            try? FileManager().removeItem(at: staleSourceRoot)
        }

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": staleSourceRoot.path,
            ])
        {
            ConsumerBundledRuntime._setTestingResourceURL(bundled.resourceRoot)
            _ = try self.makeRepoRoot(at: ConsumerBundledRuntime.installedProjectRoot())
            let identity = RuntimeIdentity.current
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/usr/bin/node",
                    staleSourceRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            try FileManager().createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            let error = await GatewayLaunchAgentManager.set(
                enabled: true,
                bundlePath: "/Applications/OpenClaw.app",
                port: identity.gatewayPort)

            #expect(error == nil)
            #expect(calls == [[
                "install",
                "--force",
                "--allow-shared-service-takeover",
                "--port",
                "\(identity.gatewayPort)",
                "--runtime",
                "node",
            ]])
        }
    }

    @MainActor
    @Test func `isolated consumer install uses current worktree entrypoint`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let canonicalRoot = try self.makeRepoRoot(named: "canonical-openclaw-\(UUID().uuidString)")
        let worktreeRoot = try self.makeRepoRoot(named: "worktree-openclaw-\(UUID().uuidString)")
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: canonicalRoot)
            try? FileManager().removeItem(at: worktreeRoot)
        }

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { false },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }
        var expectedPort = 0

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: "ui-smoke",
                "OPENCLAW_FORK_ROOT": worktreeRoot.path,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": canonicalRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            expectedPort = identity.gatewayPort
            let worktreeEntry = worktreeRoot.appendingPathComponent("dist/index.js").path
            let ownership = GatewayLaunchAgentManager.currentEntrypointOwnership(
                snapshot: LaunchAgentPlistSnapshot(
                    programArguments: ["/usr/bin/node", canonicalRoot.appendingPathComponent("dist/index.js").path, "gateway"],
                    environment: [:],
                    stdoutPath: nil,
                    stderrPath: nil,
                    port: identity.gatewayPort,
                    bind: identity.gatewayBind,
                    token: nil,
                    password: nil))
            #expect(ownership.expectedEntrypoint == worktreeEntry)
            #expect(ownership.actualEntrypoint == canonicalRoot.appendingPathComponent("dist/index.js").path)
            #expect(!ownership.matchesCurrentEntrypoint)

            let error = await GatewayLaunchAgentManager.set(
                enabled: true,
                bundlePath: "/Applications/OpenClaw.app",
                port: expectedPort)

            #expect(error == nil)
        }

        #expect(calls.count == 1)
        #expect(calls.first == ["install", "--force", "--allow-shared-service-takeover", "--port", "\(expectedPort)", "--runtime", "node"])
    }

    @MainActor
    @Test func `source launch agent ownership still uses configured project root`() async throws {
        let sourceRoot = try self.makeRepoRoot(named: "source-openclaw-\(UUID().uuidString)")
        defer {
            ConsumerBundledRuntime._clearTestingResourceURL()
            try? FileManager().removeItem(at: sourceRoot)
        }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                "OPENCLAW_TEST": "1",
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": sourceRoot.path,
            ])
        {
            let entrypoint = sourceRoot.appendingPathComponent("dist/index.js").path
            let snapshot = LaunchAgentPlistSnapshot(
                programArguments: ["/usr/bin/node", entrypoint, "gateway"],
                environment: [:],
                stdoutPath: nil,
                stderrPath: nil,
                port: nil,
                bind: nil,
                token: nil,
                password: nil)

            let ownership = GatewayLaunchAgentManager.currentEntrypointOwnership(snapshot: snapshot)

            #expect(ownership.expectedEntrypoint == entrypoint)
            #expect(ownership.actualEntrypoint == entrypoint)
            #expect(ownership.matchesCurrentEntrypoint)
        }
    }

    @MainActor
    @Test func `daemon command root canonicalizes default shared gateway worktrees`() async throws {
        let fixture = try self.makeWorktreeRepoRoot()
        defer { try? FileManager().removeItem(at: fixture.parentRoot) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": fixture.worktreeRoot.path,
            ])
        {
            let commandRoot = GatewayLaunchAgentManager._testDaemonCommandProjectRoot()

            #expect(CommandResolver.projectRoot().path == fixture.worktreeRoot.path)
            #expect(commandRoot.path == fixture.parentRoot.path)
        }
    }

    @MainActor
    @Test func `daemon command root keeps isolated consumer worktree root`() async throws {
        let fixture = try self.makeWorktreeRepoRoot()
        defer { try? FileManager().removeItem(at: fixture.parentRoot) }

        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: "telegram-smoke",
                "OPENCLAW_TEST": "1",
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": fixture.worktreeRoot.path,
            ])
        {
            let commandRoot = GatewayLaunchAgentManager._testDaemonCommandProjectRoot()

            #expect(CommandResolver.projectRoot().path == fixture.worktreeRoot.path)
            #expect(commandRoot.path == fixture.worktreeRoot.path)
        }
    }

    @Test func `enable skips loaded matching launch agent`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let installedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-installed-\(UUID().uuidString)", isDirectory: true)
        let entrypoint = installedRoot.appendingPathComponent("dist/index.js")
        let plistURL = home
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.gateway.plist")
        try FileManager().createDirectory(at: entrypoint.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager().createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: entrypoint)
        try Data().write(to: installedRoot.appendingPathComponent("package.json"))
        try Data().write(to: installedRoot.appendingPathComponent("openclaw.mjs"))
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: installedRoot)
        }

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": installedRoot.path,
            ])
        {
            let seededRoot = ConsumerBundledRuntime.installedProjectRoot()
            _ = try self.makeRepoRoot(at: seededRoot)
            let seededEntrypoint = seededRoot.appendingPathComponent("dist/index.js")
            let identity = RuntimeIdentity.current
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/usr/bin/node",
                    seededEntrypoint.path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            return await GatewayLaunchAgentManager.set(
                enabled: true,
                bundlePath: "/Applications/OpenClaw.app",
                port: identity.gatewayPort)
        }

        #expect(error == nil)
        #expect(calls.isEmpty)
    }

    @Test func `enable reinstalls matching consumer launch agent missing bundled node path`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let installedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-installed-\(UUID().uuidString)", isDirectory: true)
        let plistURL = home
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.gateway.plist")
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: installedRoot)
        }

        try FileManager().createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": installedRoot.path,
            ])
        {
            let seededRoot = ConsumerBundledRuntime.installedProjectRoot()
            _ = try self.makeRepoRoot(at: seededRoot)
            let identity = RuntimeIdentity.current
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/usr/bin/node",
                    seededRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": "/usr/bin:/bin",
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            return await GatewayLaunchAgentManager.set(
                enabled: true,
                bundlePath: "/Applications/OpenClaw.app",
                port: identity.gatewayPort)
        }

        #expect(error == nil)
        #expect(calls == [[
            "install",
            "--force",
            "--allow-shared-service-takeover",
            "--port",
            "18789",
            "--runtime",
            "node",
        ]])
    }

    @Test func `consumer stop preserves loaded matching shared gateway`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-root-\(UUID().uuidString)", isDirectory: true)
        let entrypoint = root.appendingPathComponent("dist/index.js")
        let plistURL = home
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.gateway.plist")
        try FileManager().createDirectory(at: entrypoint.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager().createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: entrypoint)
        try Data().write(to: root.appendingPathComponent("package.json"))
        try Data().write(to: root.appendingPathComponent("openclaw.mjs"))
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: root)
        }

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": root.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/usr/bin/node",
                    entrypoint.path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            #expect(GatewayLaunchAgentManager.launchAgentMatchesCurrentRuntime())
            #expect(GatewayLaunchAgentManager.currentEntrypointOwnership().matchesCurrentEntrypoint)

            return await GatewayLaunchAgentManager.set(
                enabled: false,
                bundlePath: "/Applications/OpenClaw Consumer.app",
                port: identity.gatewayPort)
        }

        #expect(error == nil)
        #expect(calls.isEmpty)
    }

    @Test func `restart or start reinstalls loaded service when entrypoint cannot be verified`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-root-\(UUID().uuidString)", isDirectory: true)
        let entrypoint = root.appendingPathComponent("dist/index.js")
        let plistURL = home
            .appendingPathComponent("Library/LaunchAgents/ai.openclaw.gateway.plist")
        try FileManager().createDirectory(at: entrypoint.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager().createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: entrypoint)
        try Data().write(to: root.appendingPathComponent("package.json"))
        try Data().write(to: root.appendingPathComponent("openclaw.mjs"))
        let staleEntrypoint = home.appendingPathComponent("stale/dist/index.js")
        let plist: [String: Any] = [
            "ProgramArguments": ["/usr/bin/node", staleEntrypoint.path, "gateway", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: [.atomic])
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: root)
        }

        var calls: [[String]] = []
        GatewayLaunchAgentManager._setTestingHooks(
            launchAgentWriteDisabled: { false },
            readDaemonLoaded: { true },
            runDaemonCommand: { args, _, _ in
                calls.append(args)
                return nil
            })
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let error = await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "standard",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_FORK_ROOT": nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": root.path,
            ])
        {
            await GatewayLaunchAgentManager.restartOrStart(
                bundlePath: "/Applications/OpenClaw.app",
                port: 18789)
        }

        #expect(error == nil)
        #expect(calls == [[
            "install",
            "--force",
            "--allow-shared-service-takeover",
            "--port",
            "18789",
            "--runtime",
            "node",
        ]])
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
        #expect(calls == [[
            "install",
            "--force",
            "--allow-shared-service-takeover",
            "--port",
            "18789",
            "--runtime",
            "node",
        ]])
    }

    @Test func `daemon command environment defaults image backend to sips`() async {
        await TestIsolation.withEnvValues([
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": nil,
        ]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: "/tmp/openclaw-worktree")

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sips")
        }
    }

    @Test func `daemon command environment persists app bundle version for service ownership`() async {
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion(" 2026.3.17 ")
        GatewayLaunchAgentManager._setTestingCurrentServiceBuild(" 2026052201 ")
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        await TestIsolation.withEnvValues([ConsumerInstance.envKey: nil]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: "/tmp/openclaw-worktree")

            #expect(env["OPENCLAW_VERSION"] == "2026.3.17")
            #expect(env["OPENCLAW_SERVICE_VERSION"] == "2026.3.17")
            #expect(env["OPENCLAW_SERVICE_BUILD"] == "2026052201")
        }
    }

    @Test func `daemon command environment preserves explicit image backend override`() async {
        await TestIsolation.withEnvValues([ConsumerInstance.envKey: nil]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: ["OPENCLAW_IMAGE_BACKEND": " sharp "],
                projectRootHint: nil)

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sharp")
        }
    }

    @Test func `daemon command environment does not inherit shell secrets`() async {
        await TestIsolation.withEnvValues([ConsumerInstance.envKey: nil]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [
                    "HOME": "/Users/tester",
                    "OPENAI_API_KEY": "sk-test",
                    "ANTHROPIC_AUTH_TOKEN": "token",
                    "CUSTOM_SECRET": "secret",
                    "PATH": "/tmp/unsafe",
                ],
                projectRootHint: nil)

            #expect(env["HOME"] == "/Users/tester")
            #expect(env["OPENAI_API_KEY"] == nil)
            #expect(env["ANTHROPIC_AUTH_TOKEN"] == nil)
            #expect(env["CUSTOM_SECRET"] == nil)
            #expect(env["PATH"] != "/tmp/unsafe")
        }
    }

    @Test func `runtime ownership blocker detects stale service version`() {
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion("2026.3.17")
        defer { GatewayLaunchAgentManager._clearTestingHooks() }

        let snapshot = LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: [
                "OPENCLAW_SERVICE_VERSION": "2026.3.16",
            ],
            stdoutPath: nil,
            stderrPath: nil,
            port: 18789,
            bind: "loopback",
            token: nil,
            password: nil)

        let message = GatewayLaunchAgentManager.runtimeOwnershipBlockerMessage(snapshot: snapshot)

        #expect(message?.contains("expects service version 2026.3.17") == true)
        #expect(message?.contains("registered as 2026.3.16") == true)
    }

    @MainActor
    @Test func `daemon command environment marks app support config as canonical owner`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_CONSUMER_INSTANCE_ID": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: [:],
                projectRootHint: nil)
            let expectedConfig = home
                .appendingPathComponent("Library/Application Support/OpenClaw/.openclaw/openclaw.json")
                .path

            #expect(env["OPENCLAW_CONFIG_PATH"] == expectedConfig)
            #expect(env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] == expectedConfig)
        }
    }

    @MainActor
    @Test func `daemon command environment omits canonical marker for isolated consumer instances`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
                base: ["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": "/stale/shared/openclaw.json"],
                projectRootHint: nil)
            let expectedConfig = home
                .appendingPathComponent(
                    "Library/Application Support/OpenClaw/instances/visible-surface-parity/.openclaw/openclaw.json")
                .path

            #expect(env["OPENCLAW_CONFIG_PATH"] == expectedConfig)
            #expect(env["OPENCLAW_LAUNCHD_LABEL"] == "ai.openclaw.consumer.visible-surface-parity.gateway")
            #expect(env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] == nil)
        }
    }

    @MainActor
    @Test func `isolated consumer launch agent matches without canonical shared marker`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let plistURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: plistURL)
        }

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let identity = RuntimeIdentity.current
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/usr/bin/node",
                    "/tmp/openclaw/dist/index.js",
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            let snapshot = try #require(LaunchAgentPlist.snapshot(url: plistURL))

            #expect(GatewayLaunchAgentManager.launchAgentMatchesCurrentRuntime(snapshot: snapshot))
        }
    }

    @MainActor
    @Test func `launchd ensure repairs healthy gateway with stale source entrypoint`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let packagedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw", isDirectory: true)
        let staleRoot = FileManager().temporaryDirectory
            .appendingPathComponent("source-openclaw-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: packagedRoot)
            try? FileManager().removeItem(at: staleRoot)
        }

        try FileManager().createDirectory(
            at: packagedRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try FileManager().createDirectory(
            at: staleRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: packagedRoot.appendingPathComponent("dist/index.js"))
        try Data().write(to: packagedRoot.appendingPathComponent("package.json"))
        try Data().write(to: packagedRoot.appendingPathComponent("openclaw.mjs"))
        try Data().write(to: staleRoot.appendingPathComponent("dist/index.js"))

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": packagedRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    staleRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            var daemonCalls: [[String]] = []
            GatewayLaunchAgentManager._setTestingHooks(
                launchAgentWriteDisabled: { false },
                readDaemonLoaded: { true },
                runDaemonCommand: { args, _, _ in
                    daemonCalls.append(args)
                    return nil
                })
            let manager = GatewayProcessManager.shared
            manager.setTestingStatus(.starting)
            defer {
                GatewayLaunchAgentManager._clearTestingHooks()
                manager.setTestingConnection(nil)
                manager.setTestingStatus(.stopped)
                manager.setTestingDesiredActive(false)
            }

            await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(daemonCalls == [[
                "install",
                "--force",
                "--allow-shared-service-takeover",
                "--port",
                "\(identity.gatewayPort)",
                "--runtime",
                "node",
            ]])
        }
    }

    @MainActor
    @Test func `launchd ensure attaches healthy packaged gateway without reinstall`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let packagedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: packagedRoot)
        }

        try FileManager().createDirectory(
            at: packagedRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: packagedRoot.appendingPathComponent("dist/index.js"))
        try Data().write(to: packagedRoot.appendingPathComponent("package.json"))
        try Data().write(to: packagedRoot.appendingPathComponent("openclaw.mjs"))

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": packagedRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    packagedRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(
                        sendHook: { task, message, sendIndex in
                            guard sendIndex > 0 else { return }
                            guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                            task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                        })
                })
            let url = try #require(URL(string: "ws://127.0.0.1:\(identity.gatewayPort)"))
            let connection = GatewayConnection(
                configProvider: { (url: url, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))

            var daemonCalls: [[String]] = []
            GatewayLaunchAgentManager._setTestingHooks(
                launchAgentWriteDisabled: { false },
                readDaemonLoaded: { false },
                runDaemonCommand: { args, _, _ in
                    daemonCalls.append(args)
                    return nil
                })
            let manager = GatewayProcessManager.shared
            manager.setTestingConnection(connection)
            manager.setTestingStatus(.starting)
            defer {
                GatewayLaunchAgentManager._clearTestingHooks()
                manager.setTestingConnection(nil)
                manager.setTestingStatus(.stopped)
                manager.setTestingDesiredActive(false)
            }

            await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(daemonCalls.isEmpty)
            if case .attachedExisting = manager.status {
                // Expected: the app attached to the already-healthy canonical gateway.
            } else {
                Issue.record("Expected attachedExisting, got \(manager.status)")
            }
        }
    }

    @MainActor
    @Test func `launchd ensure repairs healthy packaged gateway with stale service version`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        let packagedRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app/Contents/Resources/OpenClawRuntime/openclaw", isDirectory: true)
        defer {
            GatewayLaunchAgentManager._clearTestingHooks()
            try? FileManager().removeItem(at: home)
            try? FileManager().removeItem(at: packagedRoot)
        }

        try FileManager().createDirectory(
            at: packagedRoot.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: packagedRoot.appendingPathComponent("dist/index.js"))
        try Data().write(to: packagedRoot.appendingPathComponent("package.json"))
        try Data().write(to: packagedRoot.appendingPathComponent("openclaw.mjs"))
        GatewayLaunchAgentManager._setTestingCurrentServiceVersion("2026.3.17")

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_APP_VARIANT": "consumer",
                ConsumerInstance.envKey: nil,
                "OPENCLAW_TEST": "1",
                "OPENCLAW_TEST_HOME": home.path,
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": packagedRoot.path,
            ])
        {
            let identity = RuntimeIdentity.current
            let plistURL = home
                .appendingPathComponent("Library/LaunchAgents/\(identity.gatewayLaunchdLabel).plist")
            try FileManager().createDirectory(
                at: plistURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let plist: [String: Any] = [
                "ProgramArguments": [
                    "/opt/homebrew/opt/node/bin/node",
                    packagedRoot.appendingPathComponent("dist/index.js").path,
                    "gateway",
                    "--port",
                    "\(identity.gatewayPort)",
                    "--bind",
                    identity.gatewayBind,
                ],
                "EnvironmentVariables": [
                    "OPENCLAW_HOME": identity.runtimeRootURL.path,
                    "OPENCLAW_STATE_DIR": identity.stateDirURL.path,
                    "OPENCLAW_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": identity.configURL.path,
                    "OPENCLAW_SERVICE_VERSION": "2026.3.16",
                    "PATH": self.consumerLaunchdPath(for: identity),
                ],
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: [.atomic])

            var daemonCalls: [[String]] = []
            GatewayLaunchAgentManager._setTestingHooks(
                launchAgentWriteDisabled: { false },
                readDaemonLoaded: { true },
                runDaemonCommand: { args, _, _ in
                    daemonCalls.append(args)
                    return nil
                })
            GatewayLaunchAgentManager._setTestingCurrentServiceVersion("2026.3.17")
            let manager = GatewayProcessManager.shared
            manager.setTestingStatus(.starting)
            defer {
                manager.setTestingConnection(nil)
                manager.setTestingStatus(.stopped)
                manager.setTestingDesiredActive(false)
            }

            await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(daemonCalls == [[
                "install",
                "--force",
                "--allow-shared-service-takeover",
                "--port",
                "\(identity.gatewayPort)",
                "--runtime",
                "node",
            ]])
        }
    }

    @Test func `real launchd install stays pinned to canonical repo and restart preserves entrypoint`() async throws {
        #if os(macOS)
        guard await self.canRunLaunchdIntegration() else { return }

        let label = "ai.openclaw.gateway-int-\(UUID().uuidString.prefix(8))"
        let stateDir = try makeTempDirForTests()
        defer { try? FileManager().removeItem(at: stateDir) }

        let repoRoot = self.repoRoot()
        let canonicalRoot = CommandResolver.canonicalGatewayProjectRoot(projectRoot: repoRoot)
        guard !repoRoot.path.contains("/.codex/worktrees/"),
              !repoRoot.path.contains("/.worktrees/")
        else { return }
        guard canonicalRoot.standardizedFileURL == repoRoot.standardizedFileURL else { return }
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
                "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_PORT": "\(port)",
            ],
            defaults: [
                "openclaw.gatewayProjectRootPath": repoRoot.path,
            ]) {
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
                    #expect(before.environment["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] == configPath)

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
    private func makeRepoRoot(named name: String) throws -> URL {
        let root = FileManager().temporaryDirectory.appendingPathComponent(name, isDirectory: true)
        try FileManager().createDirectory(
            at: root.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("dist/index.js"))
        try Data().write(to: root.appendingPathComponent("package.json"))
        try Data().write(to: root.appendingPathComponent("openclaw.mjs"))
        return root
    }

    private func writeBundledWorkspaceTemplates(into bundledRoot: URL) throws {
        let templatesRoot = bundledRoot
            .appendingPathComponent("openclaw", isDirectory: true)
            .appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("reference", isDirectory: true)
            .appendingPathComponent("templates", isDirectory: true)

        try FileManager().createDirectory(at: templatesRoot, withIntermediateDirectories: true)
        for name in [
            "AGENTS.md",
            "SOUL.md",
            "TOOLS.md",
            "IDENTITY.md",
            "USER.md",
            "GROUPS.md",
            "HEARTBEAT.md",
            "BOOTSTRAP.md",
            "MEMORY.md",
        ] {
            let fileURL = templatesRoot.appendingPathComponent(name)
            try "# \(name)\n".write(to: fileURL, atomically: true, encoding: .utf8)
        }
    }

    private func makeBundledRuntime() throws -> (resourceRoot: URL, projectRoot: URL) {
        let appRoot = FileManager().temporaryDirectory
            .appendingPathComponent("OpenClaw.app-\(UUID().uuidString)", isDirectory: true)
        let resourceRoot = appRoot
            .appendingPathComponent("Contents/Resources/OpenClawRuntime", isDirectory: true)
        let projectRoot = resourceRoot.appendingPathComponent("openclaw", isDirectory: true)
        try FileManager().createDirectory(at: resourceRoot, withIntermediateDirectories: true)
        _ = try self.makeRepoRoot(at: projectRoot)
        return (resourceRoot, projectRoot)
    }

    private func makeBundledRuntimeInsideWorktree() throws -> (repoRoot: URL, resourceRoot: URL, projectRoot: URL) {
        let repoRoot = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-packaged-root-\(UUID().uuidString)", isDirectory: true)
        let appRoot = repoRoot
            .appendingPathComponent(".worktrees/gui-smoke/dist/OpenClaw.app", isDirectory: true)
        let resourceRoot = appRoot
            .appendingPathComponent("Contents/Resources/OpenClawRuntime", isDirectory: true)
        let projectRoot = resourceRoot.appendingPathComponent("openclaw", isDirectory: true)
        try FileManager().createDirectory(at: resourceRoot, withIntermediateDirectories: true)
        _ = try self.makeRepoRoot(at: projectRoot)
        return (repoRoot, resourceRoot, projectRoot)
    }

    private func makeRepoRoot(at root: URL) throws -> URL {
        try FileManager().createDirectory(
            at: root.appendingPathComponent("dist", isDirectory: true),
            withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("dist/index.js"))
        try Data().write(to: root.appendingPathComponent("package.json"))
        try Data().write(to: root.appendingPathComponent("openclaw.mjs"))
        return root
    }

    private func makeWorktreeRepoRoot() throws -> (parentRoot: URL, worktreeRoot: URL) {
        let parentRoot = try self.makeRepoRoot(named: "openclaw-parent-\(UUID().uuidString)")
        let worktreeRoot = parentRoot
            .appendingPathComponent(".worktrees", isDirectory: true)
            .appendingPathComponent("telegram-smoke", isDirectory: true)
        _ = try self.makeRepoRoot(at: worktreeRoot)
        return (parentRoot: parentRoot, worktreeRoot: worktreeRoot)
    }

    private func consumerLaunchdPath(for identity: RuntimeIdentity) -> String {
        [
            identity.stateDirURL.appendingPathComponent("tools/node/bin", isDirectory: true).path,
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ].joined(separator: ":")
    }

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

    @Test func `disable marker is written inside active state dir with provenance`() async throws {
        let stateDir = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir.deletingLastPathComponent()) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let error = GatewayLaunchAgentManager.setLaunchAgentWriteDisabled(
                true,
                source: "GatewayLaunchAgentManagerTests",
                reason: "unit-test")
            #expect(error == nil)

            let marker = stateDir.appendingPathComponent("disable-launchagent")
            #expect(FileManager().fileExists(atPath: marker.path))

            let data = try Data(contentsOf: marker)
            let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(json["source"] as? String == "GatewayLaunchAgentManagerTests")
            #expect(json["reason"] as? String == "unit-test")
            #expect(json["stateDir"] as? String == stateDir.path)
        }
    }

    @Test func `disable marker removal only clears active state dir`() async throws {
        let stateDir = try makeTempDirForTests().appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir.deletingLastPathComponent()) }

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            _ = GatewayLaunchAgentManager.setLaunchAgentWriteDisabled(
                true,
                source: "GatewayLaunchAgentManagerTests",
                reason: "unit-test")
            let marker = stateDir.appendingPathComponent("disable-launchagent")
            #expect(FileManager().fileExists(atPath: marker.path))

            let error = GatewayLaunchAgentManager.setLaunchAgentWriteDisabled(false)
            #expect(error == nil)
            #expect(!FileManager().fileExists(atPath: marker.path))
        }
    }
}
