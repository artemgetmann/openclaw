import Testing
@testable import OpenClaw

@Suite(.serialized)
struct DevicePairingApprovalPrompterTests {
    @Test func `auto approves consumer local node bridge requests only`() {
        #expect(
            DevicePairingApprovalPrompter.shouldAutoApproveConsumerLocalNodeBridge(
                isConsumer: true,
                clientId: "openclaw-macos",
                clientMode: "node",
                role: "node",
                remoteIp: "unknown-ip"))

        #expect(
            !DevicePairingApprovalPrompter.shouldAutoApproveConsumerLocalNodeBridge(
                isConsumer: false,
                clientId: "openclaw-macos",
                clientMode: "node",
                role: "node",
                remoteIp: "unknown-ip"))

        #expect(
            !DevicePairingApprovalPrompter.shouldAutoApproveConsumerLocalNodeBridge(
                isConsumer: true,
                clientId: "openclaw-macos",
                clientMode: "ui",
                role: "operator",
                remoteIp: "unknown-ip"))

        #expect(
            !DevicePairingApprovalPrompter.shouldAutoApproveConsumerLocalNodeBridge(
                isConsumer: true,
                clientId: "openclaw-macos",
                clientMode: "node",
                role: "node",
                remoteIp: "203.0.113.10"))
    }
}
