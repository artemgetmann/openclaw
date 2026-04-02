import Testing
@testable import OpenClaw

struct PortGuardianTests {
    @Test func `treats launchd runtime gateway command as expected`() {
        let expected = PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/opt/node/bin/node /repo/dist/index.js gateway --port 19001",
            port: 19001,
            mode: .local)

        #expect(expected)
    }

    @Test func `rejects unrelated node listener`() {
        let expected = PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/opt/node/bin/node /repo/scripts/dev-server.js --port 19001",
            port: 19001,
            mode: .local)

        #expect(!expected)
    }

    @Test func `resolves openclaw runtime paths from config file`() {
        let paths = PortGuardian._testResolveOpenClawRuntimePaths(filePaths: [
            "/Users/test/Library/Application Support/OpenClaw Consumer/instances/user-a/.openclaw/openclaw.json",
            "/tmp/other.txt",
        ])

        #expect(paths.configPath == "/Users/test/Library/Application Support/OpenClaw Consumer/instances/user-a/.openclaw/openclaw.json")
        #expect(paths.stateDir == "/Users/test/Library/Application Support/OpenClaw Consumer/instances/user-a/.openclaw")
    }

    @Test func `resolves openclaw runtime state dir from gateway log path`() {
        let paths = PortGuardian._testResolveOpenClawRuntimePaths(filePaths: [
            "/Users/test/Library/Application Support/OpenClaw Consumer/instances/user-b/.openclaw/logs/gateway.log",
        ])

        #expect(paths.configPath == nil)
        #expect(paths.stateDir == "/Users/test/Library/Application Support/OpenClaw Consumer/instances/user-b/.openclaw")
    }
}
