import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct ConsumerRuntimeTests {
    @Test func `consumer runtime exposes isolated defaults`() async {
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": nil,
        ]) {
            #expect(ConsumerRuntime.profile == "consumer")
            #expect(ConsumerRuntime.gatewayPort == 19001)
            #expect(ConsumerRuntime.gatewayBind == "loopback")
            #expect(ConsumerRuntime.launchdLabel == "ai.openclaw.consumer")
            #expect(ConsumerRuntime.gatewayLaunchdLabel == "ai.openclaw.consumer.gateway")
            #expect(ConsumerRuntime.appLaunchAgentPlistURL.lastPathComponent == "ai.openclaw.consumer.plist")
            #expect(ConsumerRuntime.gatewayLaunchAgentPlistURL
                .lastPathComponent == "ai.openclaw.consumer.gateway.plist")
        }
    }

    @Test func `consumer bootstrap process environment sets isolated runtime values`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: nil]) {
            ConsumerRuntime.bootstrapProcessEnvironment()
            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == "consumer")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_PORT") == "19001")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_BIND") == "loopback")
            #expect(OpenClawEnv.path("OPENCLAW_CONSUMER_MINIMAL_STARTUP") == "1")
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

    @Test func `named consumer instance updates runtime labels paths and env`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: "agent-a"]) {
            #expect(ConsumerRuntime.profile == "consumer-agent-a")
            #expect(ConsumerRuntime.launchdLabel == "ai.openclaw.consumer.agent-a")
            #expect(ConsumerRuntime.gatewayLaunchdLabel == "ai.openclaw.consumer.agent-a.gateway")
            #expect(ConsumerRuntime.runtimeRootURL.path.contains("/OpenClaw Consumer/instances/agent-a"))

            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path(ConsumerInstance.envKey) == "agent-a")
            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == "consumer-agent-a")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_PORT") == "\(ConsumerRuntime.gatewayPort)")
            #expect(OpenClawEnv.path("OPENCLAW_LAUNCHD_LABEL") == "ai.openclaw.consumer.agent-a.gateway")
        }
    }

    @Test func `bootstrap writes gateway mode local into consumer config`() async throws {
        let instanceID = "consumer-runtime-hardening"
        let homeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-consumer-runtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: homeURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: homeURL) }

        try await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "HOME": homeURL.path,
            ],
            defaults: ["gatewayPort": nil])
        {
            ConsumerRuntime.bootstrapProcessEnvironment()

            let data = try Data(contentsOf: ConsumerRuntime.configURL)
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let gateway = object?["gateway"] as? [String: Any]
            #expect(gateway?["mode"] as? String == "local")
        }
    }
}
