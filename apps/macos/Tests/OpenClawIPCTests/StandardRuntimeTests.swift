import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct StandardRuntimeTests {
    @Test func `standard bootstrap process environment seeds founder runtime and clears consumer markers`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_APP_VARIANT": "consumer",
            "OPENCLAW_PROFILE": "consumer",
            "OPENCLAW_CONSUMER_MINIMAL_STARTUP": "1",
            "OPENCLAW_LAUNCHD_LABEL": "ai.openclaw.consumer.gateway",
            "OPENCLAW_HOME": "/tmp/consumer-home",
            "OPENCLAW_STATE_DIR": "/tmp/consumer-home/.openclaw",
            "OPENCLAW_CONFIG_PATH": "/tmp/consumer-home/.openclaw/openclaw.json",
            "OPENCLAW_LOG_DIR": "/tmp/consumer-home/.openclaw/logs",
        ]) {
            StandardRuntime.bootstrapProcessEnvironment()

            #expect(OpenClawEnv.path("OPENCLAW_APP_VARIANT") == "standard")
            #expect(OpenClawEnv.path("OPENCLAW_PROFILE") == nil)
            #expect(OpenClawEnv.path("OPENCLAW_CONSUMER_MINIMAL_STARTUP") == nil)
            #expect(OpenClawEnv.path("OPENCLAW_LAUNCHD_LABEL") == nil)
            #expect(OpenClawEnv.path("OPENCLAW_HOME") == FileManager.default.homeDirectoryForCurrentUser.path)
            #expect(OpenClawEnv.path("OPENCLAW_STATE_DIR") == OpenClawPaths.canonicalStateDirURL(for: .standard).path)
            #expect(OpenClawEnv.path("OPENCLAW_CONFIG_PATH") == OpenClawPaths.canonicalConfigURL(for: .standard).path)
            #expect(OpenClawEnv.path("OPENCLAW_LOG_DIR") == OpenClawPaths.canonicalLogsDirURL(for: .standard).path)
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_PORT") == "18789")
            #expect(OpenClawEnv.path("OPENCLAW_GATEWAY_BIND") == "loopback")
        }
    }

    @Test func `device identity store falls back to config path parent when state dir override is absent`() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-device-identity-\(UUID().uuidString)", isDirectory: true)
        let configURL = root.appendingPathComponent("openclaw.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: root) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": nil,
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_HOME": nil,
        ]) {
            _ = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: DeviceIdentityStore.loadOrCreate().deviceId,
                role: "operator",
                token: "token")

            let identityURL = root
                .appendingPathComponent("identity", isDirectory: true)
                .appendingPathComponent("device.json", isDirectory: false)
            let authURL = root
                .appendingPathComponent("identity", isDirectory: true)
                .appendingPathComponent("device-auth.json", isDirectory: false)

            #expect(FileManager.default.fileExists(atPath: identityURL.path))
            #expect(FileManager.default.fileExists(atPath: authURL.path))
        }
    }
}
