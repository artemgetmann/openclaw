import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct ConsumerRuntimeTests {
    @Test func `consumer bootstrap defaults image backend to sips`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sips")
        }
    }

    @Test func `consumer bootstrap preserves explicit image backend override`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_IMAGE_BACKEND": "sharp",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_IMAGE_BACKEND") == "sharp")
        }
    }

    @Test func `consumer bootstrap writes main identity gateway defaults`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        try await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: nil,
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": nil,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            let data = try Data(contentsOf: ConsumerRuntime.configURL)
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let gateway = object?["gateway"] as? [String: Any]
            #expect(gateway?["mode"] as? String == "local")
            #expect(gateway?["port"] as? Int == 18_789)
            #expect(gateway?["bind"] as? String == "loopback")
            #expect(OpenClawEnv.path("OPENCLAW_LAUNCHD_LABEL") == "ai.openclaw.gateway")
            #expect(OpenClawEnv.path("OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH") == ConsumerRuntime.configURL.path)
        }
    }

    @Test func `consumer bootstrap omits canonical shared marker for isolated instances`() async throws {
        let homeURL = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: homeURL) }
        await TestIsolation.withIsolatedState(env: [
            ConsumerInstance.envKey: "visible-surface-parity",
            "OPENCLAW_TEST": "1",
            "OPENCLAW_TEST_HOME": homeURL.path,
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_HOME": nil,
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH": "/stale/shared/openclaw.json",
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_BIND": nil,
            "OPENCLAW_LOG_DIR": nil,
            "OPENCLAW_LAUNCHD_LABEL": nil,
        ]) {
            ConsumerRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == "consumer-visible-surface-parity")
            #expect(OpenClawEnv.path("OPENCLAW_CONFIG_PATH") == ConsumerRuntime.configURL.path)
            #expect(OpenClawEnv.path("OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH") == nil)
        }
    }
}
