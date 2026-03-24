import Foundation
import Testing
@testable import OpenClaw

struct ConsumerInstanceTests {
    @Test func `normalizes instance ids into stable slugs`() {
        #expect(ConsumerInstance.normalizedInstanceID("  UX Audit  ") == "ux-audit")
        #expect(ConsumerInstance.normalizedInstanceID("agent_a") == "agent-a")
        #expect(ConsumerInstance.normalizedInstanceID("___") == nil)
    }

    @Test func `default instance preserves legacy consumer runtime`() {
        let instance = ConsumerInstance.resolve(environment: [:], infoDictionary: nil)

        #expect(instance.id == nil)
        #expect(instance.profile == "consumer")
        #expect(instance.gatewayPort == 19001)
        #expect(instance.appLaunchdLabel == "ai.openclaw.consumer")
        #expect(instance.gatewayLaunchdLabel == "ai.openclaw.consumer.gateway")
        #expect(instance.defaultsPrefix == "openclaw.consumer")
        #expect(instance.stableSuiteName == "ai.openclaw.consumer.mac")
    }

    @Test func `named instance derives isolated labels paths defaults and bundle metadata`() {
        let instance = ConsumerInstance.resolve(
            environment: [ConsumerInstance.envKey: "UX Audit"],
            infoDictionary: nil)

        #expect(instance.id == "ux-audit")
        #expect(instance.profile == "consumer-ux-audit")
        #expect(instance.gatewayPort == ConsumerInstance.gatewayPort(forNormalizedInstanceID: "ux-audit"))
        #expect(instance.appLaunchdLabel == "ai.openclaw.consumer.ux-audit")
        #expect(instance.gatewayLaunchdLabel == "ai.openclaw.consumer.ux-audit.gateway")
        #expect(instance.defaultsPrefix == "openclaw.consumer.instances.ux-audit")
        #expect(instance.stableSuiteName == "ai.openclaw.consumer.mac.ux-audit")
        #expect(instance.debugAppName == "OpenClaw Consumer (ux-audit)")
        #expect(instance.debugBundleIdentifier == "ai.openclaw.consumer.mac.debug.ux-audit")
        #expect(instance.runtimeRootURL.path.contains("/OpenClaw Consumer/instances/ux-audit"))
        #expect(instance.stateDirURL.path.hasSuffix("/instances/ux-audit/.openclaw"))
    }
}
