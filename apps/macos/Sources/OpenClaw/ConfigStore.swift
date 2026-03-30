import Foundation
import OpenClawProtocol

enum ConfigStore {
    struct Overrides {
        var isRemoteMode: (@Sendable () async -> Bool)?
        var loadLocal: (@MainActor @Sendable () -> [String: Any])?
        var saveLocal: (@MainActor @Sendable ([String: Any]) -> Void)?
        var loadRemote: (@MainActor @Sendable () async -> [String: Any])?
        var saveRemote: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
    }

    private actor OverrideStore {
        var overrides = Overrides()

        func setOverride(_ overrides: Overrides) {
            self.overrides = overrides
        }
    }

    private static let overrideStore = OverrideStore()
    @MainActor private static var lastHash: String?

    private static func isRemoteMode() async -> Bool {
        let overrides = await self.overrideStore.overrides
        if let override = overrides.isRemoteMode {
            return await override()
        }
        return await MainActor.run { AppStateStore.shared.connectionMode == .remote }
    }

    @MainActor
    static func load() async -> [String: Any] {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.loadRemote {
                return await override()
            }
            return await self.loadFromGateway() ?? [:]
        }
        if let override = overrides.loadLocal {
            return override()
        }
        // Local mode owns the config file on disk. Gateway `config.get` is
        // intentionally redacted, so treating that snapshot as the source of
        // truth causes later local writes to persist placeholders such as
        // `__OPENCLAW_REDACTED__` back into the real config.
        let local = OpenClawConfigFile.loadDict()
        if !local.isEmpty {
            return local
        }
        if let gateway = await self.loadFromGateway() {
            return gateway
        }
        return local
    }

    @MainActor
    static func save(_ root: sending [String: Any]) async throws {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.saveRemote {
                try await override(root)
            } else {
                try await self.saveToGateway(root)
            }
        } else {
            if let override = overrides.saveLocal {
                override(root)
            } else {
                // Local mode should write the lane-owned file directly. Pushing
                // a full raw config through gateway RPC in local mode is both
                // unnecessary and risky because the last loaded snapshot may
                // have come from redacted gateway state instead of the real file.
                OpenClawConfigFile.saveDict(root)
            }
        }

        // Config writes can rotate the gateway token or move the effective endpoint.
        // Refresh both the resolved endpoint state and the shared socket config immediately
        // so the app does not keep reconnecting with stale credentials.
        await GatewayEndpointStore.shared.refresh()
        try? await GatewayConnection.shared.refresh()
    }

    @MainActor
    private static func loadFromGateway() async -> [String: Any]? {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            self.lastHash = snap.hash
            return snap.config?.mapValues { $0.foundationValue } ?? [:]
        } catch {
            return nil
        }
    }

    @MainActor
    private static func saveToGateway(_ root: [String: Any]) async throws {
        if self.lastHash == nil {
            _ = await self.loadFromGateway()
        }
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode config.",
            ])
        }
        var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        if let baseHash = self.lastHash {
            params["baseHash"] = AnyCodable(baseHash)
        }
        _ = try await GatewayConnection.shared.requestRaw(
            method: .configSet,
            params: params,
            timeoutMs: 10000)
        _ = await self.loadFromGateway()
    }

    #if DEBUG
    static func _testSetOverrides(_ overrides: Overrides) async {
        await self.overrideStore.setOverride(overrides)
    }

    static func _testClearOverrides() async {
        await self.overrideStore.setOverride(.init())
    }
    #endif
}
