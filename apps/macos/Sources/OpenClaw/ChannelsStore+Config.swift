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
                    ? "Config invalid; fix it in \(AgentWorkspace.displayPath(for: OpenClawPaths.configURL))."
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
        let configuredToken = self.consumerConfiguredTelegramToken(in: telegram)

        // The setup field should mirror the actual config on disk. Keeping a stale
        // in-memory token visible can make users verify or re-save the wrong bot.
        if !configuredToken.isEmpty {
            self.telegramSetupToken = configuredToken
            return
        }

        if !self.telegramBusy, self.telegramSetupPhase == .idle {
            self.telegramSetupToken = ""
        }
    }

    func restoreConfigDraftFromCurrentSource() async {
        // Real local Consumer setup must merge onto the app-owned config file.
        // The gateway snapshot can be redacted, and saving that back would corrupt
        // secrets such as gateway auth or channel tokens.
        var root: [String: Any]
        if AppFlavor.current.isConsumer,
           !self.isPreview,
           AppStateStore.shared.connectionMode != .remote
        {
            root = OpenClawConfigFile.loadDict()
        } else {
            root = await ConfigStore.load()
        }
        if root.isEmpty {
            root = OpenClawConfigFile.loadDict()
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
        // Telegram setup can rotate local auth while the gateway is reloading.
        // Write the app-owned config file directly; the setup flow owns reconnect
        // timing so it does not race a stale websocket against fresh credentials.
        OpenClawConfigFile.saveDict(self.configDraft)
        let refreshed = OpenClawConfigFile.loadDict()
        self.applyLoadedConfigRoot(refreshed)
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

#if DEBUG
extension ChannelsStore {
    func _testApplyLoadedConfigRoot(_ root: [String: Any], status: String? = nil) {
        self.applyLoadedConfigRoot(root, status: status)
    }
}
#endif

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
