import Foundation
import OpenClawProtocol

extension ChannelsStore {
    func loadConfigSchema() async {
        guard !self.configSchemaLoading else { return }
        self.configSchemaLoading = true
        defer { self.configSchemaLoading = false }

        do {
            let res: ConfigSchemaResponse = try await GatewayConnection.shared.requestDecoded(
                method: .configSchema,
                params: nil,
                timeoutMs: 8000)
            let schemaValue = res.schema.foundationValue
            self.configSchema = ConfigSchemaNode(raw: schemaValue)
            let hintValues = res.uihints.mapValues { $0.foundationValue }
            self.configUiHints = decodeUiHints(hintValues)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func loadConfig() async {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 10000)
            let root = snap.config?.mapValues { $0.foundationValue } ?? [:]
            self.applyLoadedConfigRoot(
                root,
                status: snap.valid == false
                    ? "Config invalid; fix it in the consumer config file."
                    : nil)
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    private func applyUIConfig(_ snap: ConfigSnapshot) {
        let ui = snap.config?["ui"]?.dictionaryValue
        self.applyUIConfig(root: ui?.mapValues { $0.foundationValue } ?? [:], isUIBranch: true)
    }

    private func applyUIConfig(root: [String: Any], isUIBranch: Bool = false) {
        let ui: [String: Any]?
        if isUIBranch {
            ui = root
        } else {
            ui = root["ui"] as? [String: Any]
        }
        let rawSeam = (ui?["seamColor"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        AppStateStore.shared.seamColorHex = rawSeam.isEmpty ? nil : rawSeam
    }

    private func applyLoadedConfigRoot(_ root: [String: Any], status: String? = nil) {
        self.configStatus = status
        self.configRoot = root
        self.configDraft = cloneConfigValue(root) as? [String: Any] ?? root
        self.configDirty = false
        self.configLoaded = true
        self.applyUIConfig(root: root)
        self.syncConsumerTelegramSetupFields(from: root)
    }

    private func syncConsumerTelegramSetupFields(from root: [String: Any]) {
        guard AppFlavor.current.isConsumer else { return }

        let telegram = ((root["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let configuredToken = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")

        // The onboarding field must reflect the lane-local config on disk. If it
        // drifts stale in memory, users can unknowingly verify an old bot token
        // and reintroduce the exact "already active elsewhere" conflict we were
        // trying to escape with a fresh consumer instance.
        if !configuredToken.isEmpty {
            self.telegramSetupToken = configuredToken
            return
        }

        // If the loaded config no longer has a Telegram token and the user is not
        // mid-setup, drop any stale in-memory token instead of keeping a ghost
        // value visible in the field.
        if !self.telegramBusy, self.telegramSetupPhase == .idle {
            self.telegramSetupToken = ""
        }
    }

    func restoreConfigDraftFromCurrentSource() async {
        // Telegram bootstrap must merge onto the latest config root, not whatever
        // stale/redacted draft happened to be in memory when the pane first loaded.
        var root = await ConfigStore.load()
        if root.isEmpty {
            root = OpenClawConfigFile.loadDict()
        }
        if AppFlavor.current.isConsumer {
            _ = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)
        }
        self.applyLoadedConfigRoot(root)
    }

    func channelConfigSchema(for channelId: String) -> ConfigSchemaNode? {
        guard let root = self.configSchema else { return nil }
        return root.node(at: [.key("channels"), .key(channelId)])
    }

    func configValue(at path: ConfigPath) -> Any? {
        if let value = valueAtPath(self.configDraft, path: path) {
            return value
        }
        guard path.count >= 2 else { return nil }
        if case .key("channels") = path[0], case .key = path[1] {
            let fallbackPath = Array(path.dropFirst())
            return valueAtPath(self.configDraft, path: fallbackPath)
        }
        return nil
    }

    func updateConfigValue(path: ConfigPath, value: Any?) {
        var root: Any = self.configDraft
        setValue(&root, path: path, value: value)
        self.configDraft = root as? [String: Any] ?? self.configDraft
        self.configDirty = true
    }

    @discardableResult
    func saveConfigDraftOrThrow() async throws -> [String: Any] {
        try await ConfigStore.save(self.configDraft)
        let refreshed = await ConfigStore.load()
        self.applyLoadedConfigRoot(refreshed)
        return refreshed
    }

    @discardableResult
    func saveConfigDraftLocallyAndRefresh() async -> [String: Any] {
        // Consumer Telegram bootstrap runs while the local gateway is actively
        // reloading channels. Writing the app-owned local config file directly is
        // more reliable than round-tripping the full config through gateway RPC at
        // that exact moment, and the gateway file watcher will pick the change up.
        //
        // Do not block the caller on endpoint/socket refresh here. The config write
        // is the source of truth; waiting inline on gateway reconnect work is what
        // caused the setup UI to get stuck on "Saving Telegram setup..." even after
        // the allowlist had already been persisted locally.
        OpenClawConfigFile.saveDict(self.configDraft)
        let refreshed = OpenClawConfigFile.loadDict()
        self.applyLoadedConfigRoot(refreshed)
        Task {
            await GatewayEndpointStore.shared.refresh()
            try? await GatewayConnection.shared.refresh()
        }
        return refreshed
    }

    func saveConfigDraft() async {
        guard !self.isSavingConfig else { return }
        self.isSavingConfig = true
        defer { self.isSavingConfig = false }

        do {
            _ = try await self.saveConfigDraftOrThrow()
        } catch {
            self.configStatus = error.localizedDescription
        }
    }

    func reloadConfigDraft() async {
        await self.loadConfig()
    }
}

private func valueAtPath(_ root: Any, path: ConfigPath) -> Any? {
    var current: Any? = root
    for segment in path {
        switch segment {
        case let .key(key):
            guard let dict = current as? [String: Any] else { return nil }
            current = dict[key]
        case let .index(index):
            guard let array = current as? [Any], array.indices.contains(index) else { return nil }
            current = array[index]
        }
    }
    return current
}

private func setValue(_ root: inout Any, path: ConfigPath, value: Any?) {
    guard let segment = path.first else { return }
    switch segment {
    case let .key(key):
        var dict = root as? [String: Any] ?? [:]
        if path.count == 1 {
            if let value {
                dict[key] = value
            } else {
                dict.removeValue(forKey: key)
            }
            root = dict
            return
        }
        var child = dict[key] ?? [:]
        setValue(&child, path: Array(path.dropFirst()), value: value)
        dict[key] = child
        root = dict
    case let .index(index):
        var array = root as? [Any] ?? []
        if index >= array.count {
            array.append(contentsOf: repeatElement(NSNull() as Any, count: index - array.count + 1))
        }
        if path.count == 1 {
            if let value {
                array[index] = value
            } else if array.indices.contains(index) {
                array.remove(at: index)
            }
            root = array
            return
        }
        var child = array[index]
        setValue(&child, path: Array(path.dropFirst()), value: value)
        array[index] = child
        root = array
    }
}

private func cloneConfigValue(_ value: Any) -> Any {
    guard JSONSerialization.isValidJSONObject(value) else { return value }
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
        return value
    }
}
