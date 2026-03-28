import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct CommandResolverTests {
    private func makeDefaults() -> UserDefaults {
        // Use a unique suite to avoid cross-suite concurrency on UserDefaults.standard.
        UserDefaults(suiteName: "CommandResolverTests.\(UUID().uuidString)")!
    }

    private func makeLocalDefaults() -> UserDefaults {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)
        return defaults
    }

    private func makeProjectRootWithPnpm() throws -> (tmp: URL, pnpmPath: URL) {
        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)
        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try makeExecutableForTests(at: pnpmPath)
        return (tmp, pnpmPath)
    }

    @Test func `prefers open claw binary`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])
        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `falls back to node and project entrypoint`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        try makeExecutableForTests(at: nodePath)
        try """
        #!/bin/sh
        echo v22.16.0
        """.write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        let scriptPath = tmp.appendingPathComponent("openclaw.mjs")

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == scriptPath.path)
            #expect(cmd[2] == "rpc")
        }
    }

    @Test func `prefers open claw binary over pnpm`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        let pnpmPath = binDir.appendingPathComponent("pnpm")
        try makeExecutableForTests(at: openclawPath)
        try makeExecutableForTests(at: pnpmPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "rpc"]))
    }

    @Test func `uses open claw binary without node runtime`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `prefers project entrypoint over global open claw binary`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let distEntry = tmp.appendingPathComponent("dist/index.js")
        try FileManager().createDirectory(
            at: distEntry.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try "export {}".write(to: distEntry, atomically: true, encoding: .utf8)

        let globalBinDir = tmp.appendingPathComponent("global-bin")
        let globalOpenclaw = globalBinDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: globalOpenclaw)

        let nodeDir = tmp.appendingPathComponent("node-bin")
        try FileManager().createDirectory(at: nodeDir, withIntermediateDirectories: true)
        let nodePath = nodeDir.appendingPathComponent("node")
        try """
        #!/bin/sh
        echo v22.16.0
        """.write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [nodeDir.path, globalBinDir.path])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == distEntry.path)
            #expect(cmd[2] == "gateway")
        }
    }

    @Test func `prefers repo entrypoint over project node modules wrapper when runtime exists`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let projectBinDir = tmp.appendingPathComponent("node_modules/.bin")
        let projectOpenclaw = projectBinDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: projectOpenclaw)

        let nodePath = projectBinDir.appendingPathComponent("node")
        try """
        #!/bin/sh
        echo v22.16.0
        """.write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [projectBinDir.path])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == tmp.appendingPathComponent("openclaw.mjs").path)
            #expect(cmd[2] == "gateway")
        }
    }

    @Test func `project root override keeps gateway commands pinned to canonical repo entrypoint`() throws {
        let defaults = self.makeLocalDefaults()

        let repoRoot = try makeTempDirForTests()
        let worktreeRoot = repoRoot.appendingPathComponent(".worktrees/bugfix")
        try FileManager().createDirectory(at: worktreeRoot, withIntermediateDirectories: true)

        let packageJson = "{\n  \"name\": \"openclaw\"\n}\n"
        try packageJson.write(
            to: repoRoot.appendingPathComponent("package.json"),
            atomically: true,
            encoding: .utf8)
        try "export {}\n".write(
            to: repoRoot.appendingPathComponent("openclaw.mjs"),
            atomically: true,
            encoding: .utf8)
        let canonicalEntry = repoRoot.appendingPathComponent("dist/index.js")
        try FileManager().createDirectory(
            at: canonicalEntry.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try "export {}\n".write(to: canonicalEntry, atomically: true, encoding: .utf8)

        try packageJson.write(
            to: worktreeRoot.appendingPathComponent("package.json"),
            atomically: true,
            encoding: .utf8)
        try "export {}\n".write(
            to: worktreeRoot.appendingPathComponent("openclaw.mjs"),
            atomically: true,
            encoding: .utf8)
        let worktreeEntry = worktreeRoot.appendingPathComponent("dist/index.js")
        try FileManager().createDirectory(
            at: worktreeEntry.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try "export {}\n".write(to: worktreeEntry, atomically: true, encoding: .utf8)

        let resolvedRoot = CommandResolver.canonicalGatewayProjectRoot(projectRoot: worktreeRoot)
        #expect(resolvedRoot.path == repoRoot.path)

        let globalBinDir = repoRoot.appendingPathComponent("global-bin")
        let globalOpenclaw = globalBinDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: globalOpenclaw)

        let nodeDir = repoRoot.appendingPathComponent("node-bin")
        try FileManager().createDirectory(at: nodeDir, withIntermediateDirectories: true)
        let nodePath = nodeDir.appendingPathComponent("node")
        try """
        #!/bin/sh
        echo v22.16.0
        """.write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [nodeDir.path, globalBinDir.path],
            projectRoot: resolvedRoot)

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == canonicalEntry.path)
            #expect(cmd[2] == "gateway")
        }
    }

    @Test func `falls back to pnpm`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "openclaw", "rpc"]))
    }

    @Test func `pnpm keeps extra args after subcommand`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "health",
            extraArgs: ["--json", "--timeout", "5"],
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "openclaw", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func `preferred paths start with project node bins`() throws {
        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let first = CommandResolver.preferredPaths().first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func `builds SSH command for remote mode`() {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)
        defaults.set("/tmp/id_ed25519", forKey: remoteIdentityKey)
        defaults.set("/srv/openclaw", forKey: remoteProjectRootKey)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "status",
            extraArgs: ["--json"],
            defaults: defaults,
            configRoot: [:])

        #expect(cmd.first == "/usr/bin/ssh")
        if let marker = cmd.firstIndex(of: "--") {
            #expect(cmd[marker + 1] == "openclaw@example.com")
        } else {
            #expect(Bool(false))
        }
        #expect(cmd.contains("-i"))
        #expect(cmd.contains("/tmp/id_ed25519"))
        if let script = cmd.last {
            #expect(script.contains("PRJ='/srv/openclaw'"))
            #expect(script.contains("cd \"$PRJ\""))
            #expect(script.contains("openclaw"))
            #expect(script.contains("status"))
            #expect(script.contains("--json"))
            #expect(script.contains("CLI="))
        }
    }

    @Test func `rejects unsafe SSH targets`() {
        #expect(CommandResolver.parseSSHTarget("-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("host:-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("user@host:2222")?.port == 2222)
    }

    @Test func `config root local overrides remote defaults`() throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "daemon",
            defaults: defaults,
            configRoot: ["gateway": ["mode": "local"]])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0].hasSuffix("/node"))
            #expect(cmd[1] == tmp.appendingPathComponent("openclaw.mjs").path)
            #expect(cmd[2] == "daemon")
        }
    }
}
