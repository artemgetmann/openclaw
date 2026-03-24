import OpenClawProtocol
import SwiftUI

extension ChannelsSettings {
    private var isConsumerSimpleTelegramPath: Bool {
        AppFlavor.current.isConsumer && !UserDefaults.standard.bool(forKey: showAdvancedSettingsKey)
    }

    private func consumerTelegramConflictMessage(_ raw: String?) -> String? {
        guard self.isConsumerSimpleTelegramPath else { return nil }
        let normalized = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        guard !normalized.isEmpty else { return nil }
        if normalized.contains("terminated by other getupdates request")
            || normalized.contains("already being used by another openclaw telegram poller")
        {
            // Telegram returns a raw 409 string here, but consumer users need the
            // actual meaning: some other local OpenClaw lane already owns this bot.
            return "This bot is already active in another OpenClaw window or worktree on this Mac. Close the other runtime or use a different bot token here."
        }
        return nil
    }

    private var consumerTelegramConfigFallback: (configured: Bool, lockedSenderId: String?) {
        guard self.isConsumerSimpleTelegramPath else { return (false, nil) }

        // The consumer Telegram lane should stay legible even while the gateway is
        // still reconnecting. Fall back to the locally persisted config instead of
        // pretending Telegram has vanished just because the latest status probe has
        // not landed yet.
        let root = self.store.configDraft.isEmpty ? OpenClawConfigFile.loadDict() : self.store.configDraft
        let telegram = ((root["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let enabled = telegram["enabled"] as? Bool ?? false
        let token = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        let allowFrom = (telegram["allowFrom"] as? [String]) ?? []
        return (enabled && !token.isEmpty, allowFrom.first)
    }

    private var consumerTelegramLooksLive: Bool {
        guard self.isConsumerSimpleTelegramPath else { return false }
        if let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self) {
            if status.configured && (status.running || status.probe?.ok == true) {
                return true
            }
        }
        let fallback = self.consumerTelegramConfigFallback
        return fallback.configured && fallback.lockedSenderId != nil
    }

    var consumerTelegramBotUsername: String? {
        if let username = self.channelStatus(
            "telegram",
            as: ChannelsStatusSnapshot.TelegramStatus.self)?.probe?.bot?.username,
           !username.isEmpty
        {
            return username
        }
        if let username = self.store.telegramSetupBotUsername, !username.isEmpty {
            return username
        }
        let persisted = UserDefaults.standard.string(
            forKey: ChannelsStore.consumerTelegramBotUsernameDefaultsKey)
        return (persisted?.isEmpty == false) ? persisted : nil
    }

    private func channelStatus<T: Decodable>(
        _ id: String,
        as type: T.Type) -> T?
    {
        self.store.snapshot?.decodeChannel(id, as: type)
    }

    private func configuredChannelTint(configured: Bool, running: Bool, hasError: Bool, probeOk: Bool?) -> Color {
        if !configured { return .secondary }
        if hasError { return .orange }
        if probeOk == false { return .orange }
        if running { return .green }
        return .orange
    }

    private func configuredChannelSummary(configured: Bool, running: Bool) -> String {
        if !configured { return "Not configured" }
        if running { return "Running" }
        return "Configured"
    }

    private func appendProbeDetails(
        lines: inout [String],
        probeOk: Bool?,
        probeStatus: Int?,
        probeElapsedMs: Double?,
        probeVersion: String? = nil,
        probeError: String? = nil,
        lastProbeAtMs: Double?,
        lastError: String?)
    {
        if let probeOk {
            if probeOk {
                if let version = probeVersion, !version.isEmpty {
                    lines.append("Version \(version)")
                }
                if let elapsed = probeElapsedMs {
                    lines.append("Probe \(Int(elapsed))ms")
                }
            } else if let probeError, !probeError.isEmpty {
                lines.append("Probe error: \(probeError)")
            } else {
                let code = probeStatus.map { String($0) } ?? "unknown"
                lines.append("Probe failed (\(code))")
            }
        }
        if let last = self.date(fromMs: lastProbeAtMs) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let lastError, !lastError.isEmpty {
            lines.append("Error: \(lastError)")
        }
    }

    private func finishDetails(
        lines: inout [String],
        probeOk: Bool?,
        probeStatus: Int?,
        probeElapsedMs: Double?,
        probeVersion: String? = nil,
        probeError: String? = nil,
        lastProbeAtMs: Double?,
        lastError: String?) -> String?
    {
        self.appendProbeDetails(
            lines: &lines,
            probeOk: probeOk,
            probeStatus: probeStatus,
            probeElapsedMs: probeElapsedMs,
            probeVersion: probeVersion,
            probeError: probeError,
            lastProbeAtMs: lastProbeAtMs,
            lastError: lastError)
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    private func finishProbeDetails(
        lines: inout [String],
        probe: (ok: Bool?, status: Int?, elapsedMs: Double?),
        lastProbeAtMs: Double?,
        lastError: String?) -> String?
    {
        self.finishDetails(
            lines: &lines,
            probeOk: probe.ok,
            probeStatus: probe.status,
            probeElapsedMs: probe.elapsedMs,
            lastProbeAtMs: lastProbeAtMs,
            lastError: lastError)
    }

    var whatsAppTint: Color {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if !status.linked { return .red }
        if status.lastError != nil { return .orange }
        if status.connected { return .green }
        if status.running { return .orange }
        return .orange
    }

    var telegramTint: Color {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else {
            let fallback = self.consumerTelegramConfigFallback
            guard fallback.configured else { return .secondary }
            return fallback.lockedSenderId == nil ? .orange : .green
        }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var discordTint: Color {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var googlechatTint: Color {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var signalTint: Color {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var imessageTint: Color {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var whatsAppSummary: String {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return "Checking…" }
        if !status.linked { return "Not linked" }
        if status.connected { return "Connected" }
        if status.running { return "Running" }
        return "Linked"
    }

    var telegramSummary: String {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else {
            if self.consumerTelegramConflictMessage(self.store.telegramSetupStatus) != nil {
                return "Busy elsewhere"
            }
            let fallback = self.consumerTelegramConfigFallback
            if self.isConsumerSimpleTelegramPath {
                if fallback.lockedSenderId != nil { return "Live" }
                if fallback.configured { return "Setup complete" }
                return "Setup needed"
            }
            if fallback.configured { return "Configured" }
            return "Checking…"
        }
        if self.isConsumerSimpleTelegramPath {
            if self.consumerTelegramConflictMessage(status.lastError) != nil { return "Busy elsewhere" }
            if status.configured && (status.running || status.probe?.ok == true) { return "Live" }
            if status.configured { return "Setup complete" }
            return "Setup needed"
        }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var discordSummary: String {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var googlechatSummary: String {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var signalSummary: String {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var imessageSummary: String {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var whatsAppDetails: String? {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return nil }
        var lines: [String] = []
        if let e164 = status.`self`?.e164 ?? status.`self`?.jid {
            lines.append("Linked as \(e164)")
        }
        if let age = status.authAgeMs {
            lines.append("Auth age \(msToAge(age))")
        }
        if let last = self.date(fromMs: status.lastConnectedAt) {
            lines.append("Last connect \(relativeAge(from: last))")
        }
        if let disconnect = status.lastDisconnect {
            let when = self.date(fromMs: disconnect.at).map { relativeAge(from: $0) } ?? "unknown"
            let code = disconnect.status.map { "status \($0)" } ?? "status unknown"
            let err = disconnect.error ?? "disconnect"
            lines.append("Last disconnect \(code) · \(err) · \(when)")
        }
        if status.reconnectAttempts > 0 {
            lines.append("Reconnect attempts \(status.reconnectAttempts)")
        }
        if let msgAt = self.date(fromMs: status.lastMessageAt) {
            lines.append("Last message \(relativeAge(from: msgAt))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    var telegramDetails: String? {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else {
            if let conflict = self.consumerTelegramConflictMessage(self.store.telegramSetupStatus) {
                return conflict
            }
            if self.isConsumerSimpleTelegramPath {
                // Consumer setup already shows inline status inside the setup/live
                // card. Repeating the same copy again in the header just creates
                // duplicate noise above the real controls.
                return nil
            }
            if let status = self.store.telegramSetupStatus, !status.isEmpty {
                return status
            }
            let fallback = self.consumerTelegramConfigFallback
            if fallback.lockedSenderId != nil {
                return self.isConsumerSimpleTelegramPath
                    ? "Telegram access is saved on this Mac."
                    : "Telegram DM allowlist saved locally."
            }
            if fallback.configured {
                return self.isConsumerSimpleTelegramPath
                    ? "Telegram setup is saved on this Mac."
                    : "Telegram token saved locally."
            }
            return nil
        }
        var lines: [String] = []
        if let conflict = self.consumerTelegramConflictMessage(status.lastError) {
            return conflict
        }
        if self.isConsumerSimpleTelegramPath {
            return nil
        }
        if let source = status.tokenSource, !self.isConsumerSimpleTelegramPath {
            lines.append("Token source: \(source)")
        }
        if let mode = status.mode, !self.isConsumerSimpleTelegramPath {
            lines.append("Mode: \(mode)")
        }
        if let probe = status.probe {
            if probe.ok {
                if let name = probe.bot?.username {
                    lines.append("Bot: @\(name)")
                }
                if let url = probe.webhook?.url, !url.isEmpty {
                    lines.append("Webhook: \(url)")
                }
            }
        }
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: status.probe?.status,
            probeElapsedMs: nil,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var discordDetails: String? {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.tokenSource {
            lines.append("Token source: \(source)")
        }
        if let name = status.probe?.bot?.username, !name.isEmpty {
            lines.append("Bot: @\(name)")
        }
        return self.finishProbeDetails(
            lines: &lines,
            probe: (
                ok: status.probe?.ok,
                status: status.probe?.status,
                elapsedMs: status.probe?.elapsedMs),
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var googlechatDetails: String? {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.credentialSource {
            lines.append("Credential: \(source)")
        }
        if let audienceType = status.audienceType {
            let audience = status.audience ?? ""
            let label = audience.isEmpty ? audienceType : "\(audienceType) \(audience)"
            lines.append("Audience: \(label)")
        }
        return self.finishProbeDetails(
            lines: &lines,
            probe: (
                ok: status.probe?.ok,
                status: status.probe?.status,
                elapsedMs: status.probe?.elapsedMs),
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var signalDetails: String? {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return nil }
        var lines: [String] = []
        lines.append("Base URL: \(status.baseUrl)")
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: status.probe?.status,
            probeElapsedMs: status.probe?.elapsedMs,
            probeVersion: status.probe?.version,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var imessageDetails: String? {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return nil }
        var lines: [String] = []
        if let cliPath = status.cliPath, !cliPath.isEmpty {
            lines.append("CLI: \(cliPath)")
        }
        if let dbPath = status.dbPath, !dbPath.isEmpty {
            lines.append("DB: \(dbPath)")
        }
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: nil,
            probeElapsedMs: nil,
            probeError: status.probe?.error,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var orderedChannels: [ChannelItem] {
        let fallback = AppFlavor.current.isConsumer
            ? ["telegram", "whatsapp", "discord", "googlechat", "slack", "signal", "imessage"]
            : ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage"]
        let snapshotOrder = self.store.snapshot?.channelOrder ?? []
        let order = snapshotOrder.isEmpty ? fallback : snapshotOrder
        let channels = order.enumerated().map { index, id in
            ChannelItem(
                id: id,
                title: self.resolveChannelTitle(id),
                detailTitle: self.resolveChannelDetailTitle(id),
                systemImage: self.resolveChannelSystemImage(id),
                sortOrder: index)
        }
        let sorted = channels.sorted { lhs, rhs in
            let lhsEnabled = self.channelEnabled(lhs)
            let rhsEnabled = self.channelEnabled(rhs)
            if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
            return lhs.sortOrder < rhs.sortOrder
        }

        guard AppFlavor.current.isConsumer,
              !UserDefaults.standard.bool(forKey: showAdvancedSettingsKey)
        else {
            return sorted
        }

        // Normal consumer path is Telegram-first. Keep other channels available
        // behind Advanced without removing them from the app/runtime codebase.
        let simplified = sorted.filter { $0.id == "telegram" }
        return simplified.isEmpty ? sorted : simplified
    }

    var enabledChannels: [ChannelItem] {
        self.orderedChannels.filter { self.channelEnabled($0) }
    }

    var availableChannels: [ChannelItem] {
        self.orderedChannels.filter { !self.channelEnabled($0) }
    }

    func ensureSelection() {
        guard let selected = self.selectedChannel else {
            self.selectedChannel = self.orderedChannels.first
            return
        }
        if !self.orderedChannels.contains(selected) {
            self.selectedChannel = self.orderedChannels.first
        }
    }

    func channelEnabled(_ channel: ChannelItem) -> Bool {
        let status = self.channelStatusDictionary(channel.id)
        let configured = status?["configured"]?.boolValue ?? false
        let running = status?["running"]?.boolValue ?? false
        let connected = status?["connected"]?.boolValue ?? false
        let accountActive = self.store.snapshot?.channelAccounts[channel.id]?.contains(
            where: { $0.configured == true || $0.running == true || $0.connected == true }) ?? false
        if channel.id == "telegram", !configured, !running, !connected, !accountActive,
           self.consumerTelegramConfigFallback.configured
        {
            return true
        }
        return configured || running || connected || accountActive
    }

    @ViewBuilder
    func channelSection(_ channel: ChannelItem) -> some View {
        if channel.id == "whatsapp" {
            self.whatsAppSection
        } else if channel.id == "telegram" {
            if AppFlavor.current.isConsumer && !UserDefaults.standard.bool(forKey: showAdvancedSettingsKey) {
                // Once the consumer Telegram lane is already configured and healthy,
                // always prefer the steady-state "bot is live" card over the setup
                // wizard. The setup phase can lag behind reality when background
                // refreshes or launchd restarts finish out of order, and showing the
                // wizard again just makes a working bot look broken.
                if self.consumerTelegramLooksLive {
                    self.consumerTelegramLiveSection
                } else {
                    self.telegramSetupSection
                }
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    self.telegramSetupSection
                    self.genericChannelSection(channel)
                }
            }
        } else {
            self.genericChannelSection(channel)
        }
    }

    func channelTint(_ channel: ChannelItem) -> Color {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppTint
        case "telegram":
            return self.telegramTint
        case "discord":
            return self.discordTint
        case "googlechat":
            return self.googlechatTint
        case "signal":
            return self.signalTint
        case "imessage":
            return self.imessageTint
        default:
            if self.channelHasError(channel) { return .orange }
            if self.channelEnabled(channel) { return .green }
            return .secondary
        }
    }

    func channelSummary(_ channel: ChannelItem) -> String {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppSummary
        case "telegram":
            return self.telegramSummary
        case "discord":
            return self.discordSummary
        case "googlechat":
            return self.googlechatSummary
        case "signal":
            return self.signalSummary
        case "imessage":
            return self.imessageSummary
        default:
            if self.channelHasError(channel) { return "Error" }
            if self.channelEnabled(channel) { return "Active" }
            return "Not configured"
        }
    }

    func channelDetails(_ channel: ChannelItem) -> String? {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppDetails
        case "telegram":
            return self.telegramDetails
        case "discord":
            return self.discordDetails
        case "googlechat":
            return self.googlechatDetails
        case "signal":
            return self.signalDetails
        case "imessage":
            return self.imessageDetails
        default:
            let status = self.channelStatusDictionary(channel.id)
            if let err = status?["lastError"]?.stringValue, !err.isEmpty {
                return "Error: \(err)"
            }
            return nil
        }
    }

    func channelLastCheckText(_ channel: ChannelItem) -> String {
        guard let date = self.channelLastCheck(channel) else { return "never" }
        return relativeAge(from: date)
    }

    func channelLastCheck(_ channel: ChannelItem) -> Date? {
        switch channel.id {
        case "whatsapp":
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return nil }
            return self.date(fromMs: status.lastEventAt ?? status.lastMessageAt ?? status.lastConnectedAt)
        case "telegram":
            return self
                .date(fromMs: self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
                    .lastProbeAt)
        case "discord":
            return self
                .date(fromMs: self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)?
                    .lastProbeAt)
        case "googlechat":
            return self
                .date(fromMs: self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)?
                    .lastProbeAt)
        case "signal":
            return self
                .date(fromMs: self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)?.lastProbeAt)
        case "imessage":
            return self
                .date(fromMs: self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)?
                    .lastProbeAt)
        default:
            let status = self.channelStatusDictionary(channel.id)
            if let probeAt = status?["lastProbeAt"]?.doubleValue {
                return self.date(fromMs: probeAt)
            }
            if let accounts = self.store.snapshot?.channelAccounts[channel.id] {
                let last = accounts.compactMap { $0.lastInboundAt ?? $0.lastOutboundAt }.max()
                return self.date(fromMs: last)
            }
            return nil
        }
    }

    func channelHasError(_ channel: ChannelItem) -> Bool {
        switch channel.id {
        case "whatsapp":
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.lastDisconnect?.loggedOut == true
        case "telegram":
            guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "discord":
            guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "googlechat":
            guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "signal":
            guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "imessage":
            guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        default:
            let status = self.channelStatusDictionary(channel.id)
            return status?["lastError"]?.stringValue?.isEmpty == false
        }
    }

    private func resolveChannelTitle(_ id: String) -> String {
        let label = self.store.resolveChannelLabel(id)
        if label != id { return label }
        return id.prefix(1).uppercased() + id.dropFirst()
    }

    private func resolveChannelDetailTitle(_ id: String) -> String {
        self.store.resolveChannelDetailLabel(id)
    }

    private func resolveChannelSystemImage(_ id: String) -> String {
        self.store.resolveChannelSystemImage(id)
    }

    private func channelStatusDictionary(_ id: String) -> [String: AnyCodable]? {
        self.store.snapshot?.channels[id]?.dictionaryValue
    }
}
