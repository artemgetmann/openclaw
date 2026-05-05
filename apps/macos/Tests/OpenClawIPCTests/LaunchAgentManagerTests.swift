import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct LaunchAgentManagerTests {
    @Test func `launch agent environment defaults image backend to sips`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_IMAGE_BACKEND": nil]) {
            let env = LaunchAgentManager.launchAgentEnvironment(base: [:])

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sips")
        }
    }

    @Test func `launch agent environment preserves explicit image backend override`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_IMAGE_BACKEND": nil]) {
            let env = LaunchAgentManager.launchAgentEnvironment(
                base: ["OPENCLAW_IMAGE_BACKEND": " sharp "])

            #expect(env["OPENCLAW_IMAGE_BACKEND"] == "sharp")
        }
    }

    @MainActor
    @Test func `launch agent environment omits canonical marker for isolated consumer instances`() async throws {
        let home = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: home) }

        await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_APP_VARIANT": "consumer",
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": home.path,
        ]) {
            let env = LaunchAgentManager.launchAgentEnvironment(base: [:])

            #expect(env["OPENCLAW_CONFIG_PATH"] == ConsumerRuntime.configURL.path)
            #expect(env["OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH"] == nil)
        }
    }
}
