import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerRuntimeTests {
    @Test func `bootstrap seeds instance derived runtime environment`() async {
        let instanceID = "consumer-first-run-hardening-20260410"
        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: instanceID,
                "OPENCLAW_APP_VARIANT": "consumer",
                "OPENCLAW_GATEWAY_PORT": nil,
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_STATE_DIR": nil,
                "OPENCLAW_HOME": nil,
                "OPENCLAW_LOG_DIR": nil,
                "OPENCLAW_PROFILE": nil,
                "OPENCLAW_LAUNCHD_LABEL": nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            ConsumerRuntime.bootstrapProcessEnvironment()

            let expectedInstance = ConsumerInstance.current
            #expect(expectedInstance.id == instanceID)
            #expect(ProcessInfo.processInfo.environment["OPENCLAW_GATEWAY_PORT"] == String(expectedInstance.gatewayPort))
            #expect(ProcessInfo.processInfo.environment["OPENCLAW_CONFIG_PATH"] == expectedInstance.configURL.path)
            #expect(ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"] == expectedInstance.stateDirURL.path)
            #expect(ProcessInfo.processInfo.environment["OPENCLAW_HOME"] == expectedInstance.runtimeRootURL.path)
            #expect(ProcessInfo.processInfo.environment["OPENCLAW_PROFILE"] == expectedInstance.profile)
            #expect(GatewayEnvironment.gatewayPort() == expectedInstance.gatewayPort)
        }
    }
}
