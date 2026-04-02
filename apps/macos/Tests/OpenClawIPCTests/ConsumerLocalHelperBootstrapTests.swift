import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerLocalHelperBootstrapTests {
    @Test func `consumer local modes bootstrap helper when missing`() {
        #expect(
            ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .local,
                installedLocation: nil))
        #expect(
            ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .unconfigured,
                installedLocation: nil))
    }

    @Test func `remote or already installed lanes skip helper bootstrap`() {
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .remote,
                installedLocation: nil))
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: true,
                connectionMode: .local,
                installedLocation: "/tmp/openclaw"))
        #expect(
            !ConsumerLocalHelperBootstrap.shouldBootstrap(
                isConsumer: false,
                connectionMode: .local,
                installedLocation: nil))
    }
}
