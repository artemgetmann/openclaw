import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct ConsumerRuntimeTests {
    @Test func `consumer bootstrap defaults image backend to sips`() async {
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sips")
        }
    }

    @Test func `consumer bootstrap preserves explicit image backend override`() async {
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": "sharp",
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sharp")
        }
    }
}
