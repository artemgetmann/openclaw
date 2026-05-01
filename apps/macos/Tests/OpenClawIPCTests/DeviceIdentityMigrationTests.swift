import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct DeviceIdentityMigrationTests {
    @Test func `imports legacy app support operator identity into canonical state dir`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-identity-\(UUID().uuidString)", isDirectory: true)
        let stateDir = root.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        let legacyIdentityDir = root.appendingPathComponent("identity", isDirectory: true)
        let stateIdentityDir = stateDir.appendingPathComponent("identity", isDirectory: true)
        try FileManager().createDirectory(at: legacyIdentityDir, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: stateIdentityDir, withIntermediateDirectories: true)

        try self.writeIdentity(
            deviceId: "legacy-device",
            to: legacyIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "legacy-device",
            roles: ["operator": "legacy-token"],
            to: legacyIdentityDir.appendingPathComponent("device-auth.json"))
        try self.writeIdentity(
            deviceId: "stale-device",
            to: stateIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "other-device",
            roles: ["operator": "stale-token"],
            to: stateIdentityDir.appendingPathComponent("device-auth.json"))

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            #expect(DeviceIdentityStore.migrateLegacyAppSupportIdentityIfNeeded())
            #expect(DeviceIdentityStore.loadOrCreate().deviceId == "legacy-device")
            #expect(DeviceAuthStore.loadToken(deviceId: "legacy-device", role: "operator")?.token == "legacy-token")
        }
    }

    @Test func `keeps healthy canonical operator identity`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-identity-\(UUID().uuidString)", isDirectory: true)
        let stateDir = root.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        let legacyIdentityDir = root.appendingPathComponent("identity", isDirectory: true)
        let stateIdentityDir = stateDir.appendingPathComponent("identity", isDirectory: true)
        try FileManager().createDirectory(at: legacyIdentityDir, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: stateIdentityDir, withIntermediateDirectories: true)

        try self.writeIdentity(
            deviceId: "legacy-device",
            to: legacyIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "legacy-device",
            roles: ["operator": "legacy-token"],
            to: legacyIdentityDir.appendingPathComponent("device-auth.json"))
        try self.writeIdentity(
            deviceId: "current-device",
            to: stateIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "current-device",
            roles: ["operator": "current-token"],
            to: stateIdentityDir.appendingPathComponent("device-auth.json"))

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            #expect(!DeviceIdentityStore.migrateLegacyAppSupportIdentityIfNeeded())
            #expect(DeviceIdentityStore.loadOrCreate().deviceId == "current-device")
            #expect(DeviceAuthStore.loadToken(deviceId: "current-device", role: "operator")?.token == "current-token")
        }
    }

    @Test func `load or create repairs mismatched canonical identity from legacy operator identity`() async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-identity-\(UUID().uuidString)", isDirectory: true)
        let stateDir = root.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        let legacyIdentityDir = root.appendingPathComponent("identity", isDirectory: true)
        let stateIdentityDir = stateDir.appendingPathComponent("identity", isDirectory: true)
        try FileManager().createDirectory(at: legacyIdentityDir, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: stateIdentityDir, withIntermediateDirectories: true)

        try self.writeIdentity(
            deviceId: "legacy-device",
            to: legacyIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "legacy-device",
            roles: ["operator": "legacy-token", "node": "legacy-node-token"],
            to: legacyIdentityDir.appendingPathComponent("device-auth.json"))
        try self.writeIdentity(
            deviceId: "node-race-device",
            to: stateIdentityDir.appendingPathComponent("device.json"))
        try self.writeAuth(
            deviceId: "operator-race-device",
            roles: ["operator": "operator-race-token"],
            to: stateIdentityDir.appendingPathComponent("device-auth.json"))

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            #expect(DeviceIdentityStore.loadOrCreate().deviceId == "legacy-device")
            #expect(DeviceAuthStore.loadToken(deviceId: "legacy-device", role: "operator")?.token == "legacy-token")
            #expect(DeviceAuthStore.loadToken(deviceId: "legacy-device", role: "node")?.token == "legacy-node-token")
        }
    }

    @Test func `concurrent load or create uses one device identity`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-identity-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let ids = await withTaskGroup(of: String.self) { group in
                for _ in 0..<30 {
                    group.addTask {
                        DeviceIdentityStore.loadOrCreate().deviceId
                    }
                }

                var values: [String] = []
                for await id in group {
                    values.append(id)
                }
                return values
            }

            #expect(Set(ids).count == 1)
            #expect(DeviceIdentityStore.loadOrCreate().deviceId == ids.first)
        }
    }

    @Test func `concurrent auth token stores preserve roles for one device`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-auth-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let identity = DeviceIdentityStore.loadOrCreate()
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<20 {
                    group.addTask {
                        _ = DeviceAuthStore.storeToken(
                            deviceId: identity.deviceId,
                            role: "operator",
                            token: "operator-token")
                    }
                    group.addTask {
                        _ = DeviceAuthStore.storeToken(
                            deviceId: identity.deviceId,
                            role: "node",
                            token: "node-token")
                    }
                }
            }

            #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator")?.token == "operator-token")
            #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node")?.token == "node-token")
        }
    }

    private func writeIdentity(deviceId: String, to url: URL) throws {
        let payload: [String: Any] = [
            "deviceId": deviceId,
            "publicKey": "public-key",
            "privateKey": "private-key",
            "createdAtMs": 1,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
    }

    private func writeAuth(deviceId: String, roles: [String: String], to url: URL) throws {
        var tokens: [String: [String: Any]] = [:]
        for (role, token) in roles {
            tokens[role] = [
                "token": token,
                "role": role,
                "scopes": ["operator.read"],
                "updatedAtMs": 1,
            ]
        }
        let payload: [String: Any] = [
            "version": 1,
            "deviceId": deviceId,
            "tokens": tokens,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
    }
}
