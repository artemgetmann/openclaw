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
}
