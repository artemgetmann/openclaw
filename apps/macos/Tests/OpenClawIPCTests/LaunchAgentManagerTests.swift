import Foundation
import Testing
@testable import OpenClaw

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
}
