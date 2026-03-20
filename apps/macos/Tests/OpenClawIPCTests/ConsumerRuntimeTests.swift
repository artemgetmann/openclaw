import Foundation
import Testing
@testable import OpenClaw

struct ConsumerRuntimeTests {
    @Test func `consumer runtime exposes isolated defaults`() {
        #expect(ConsumerRuntime.profile == "consumer")
        #expect(ConsumerRuntime.gatewayPort == 19001)
        #expect(ConsumerRuntime.gatewayBind == "loopback")
        #expect(ConsumerRuntime.launchdLabel == "ai.openclaw.consumer")
        #expect(ConsumerRuntime.gatewayLaunchdLabel == "ai.openclaw.consumer.gateway")
        #expect(ConsumerRuntime.appLaunchAgentPlistURL.lastPathComponent == "ai.openclaw.consumer.plist")
        #expect(ConsumerRuntime.gatewayLaunchAgentPlistURL.lastPathComponent == "ai.openclaw.consumer.gateway.plist")
    }

    @Test func `consumer bootstrap process environment sets isolated runtime values`() async {
        await TestIsolation.withIsolatedState {
            ConsumerRuntime.bootstrapProcessEnvironment()
            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == "consumer")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_PORT") == "19001")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_BIND") == "loopback")
            #expect(OpenClawEnv.path("OPENCLAW_CONSUMER_MINIMAL_STARTUP") == "1")
        }
    }
}
