import Foundation

private struct ConsumerTelegramConfigFallback {
    let configured: Bool
    let lockedSenderId: String?
}

extension ChannelsStore {
    static let consumerTelegramBotUsernameDefaultsKey = "OpenClawConsumerTelegramBotUsername"

    static func consumerTelegramFirstTaskVerificationDefaultsKey(
        instanceId: String? = ConsumerInstance.current.id
    ) -> String {
        let trimmed = instanceId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let suffix = trimmed.isEmpty ? "default" : trimmed
        return "OpenClawConsumerTelegramFirstTaskVerified.\(suffix)"
    }

    var consumerTelegramFirstTaskVerified: Bool {
        guard let botId = self.consumerTelegramConfiguredBotId() else { return false }
        let key = Self.consumerTelegramFirstTaskVerificationDefaultsKey()
        guard let stored = UserDefaults.standard.object(forKey: key) as? Int else { return false }
        return stored == botId
    }

    func markConsumerTelegramFirstTaskVerified() {
        guard let botId = self.consumerTelegramConfiguredBotId() else { return }
        UserDefaults.standard.set(
            botId,
            forKey: Self.consumerTelegramFirstTaskVerificationDefaultsKey())
    }

    func clearConsumerTelegramFirstTaskVerified() {
        UserDefaults.standard.removeObject(
            forKey: Self.consumerTelegramFirstTaskVerificationDefaultsKey())
    }

    func consumerTelegramConflictMessage(_ raw: String?) -> String? {
        guard AppFlavor.current.isConsumer else { return nil }
        let normalized = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        guard !normalized.isEmpty else { return nil }
        if normalized.contains("terminated by other getupdates request")
            || normalized.contains("already being used by another openclaw telegram poller")
        {
            return "This bot is already active in another OpenClaw window or worktree on this Mac. Close the other runtime or use a different bot token here."
        }
        return nil
    }

    func consumerTelegramBotUsername() -> String? {
        if let username = self.snapshot?
            .decodeChannel("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
            .probe?.bot?.username,
           !username.isEmpty
        {
            return username
        }
        if let username = self.telegramSetupBotUsername, !username.isEmpty {
            return username
        }
        let persisted = UserDefaults.standard.string(
            forKey: Self.consumerTelegramBotUsernameDefaultsKey)
        return (persisted?.isEmpty == false) ? persisted : nil
    }

    func consumerTelegramLooksLive() -> Bool {
        guard AppFlavor.current.isConsumer else { return false }
        if let status = self.snapshot?.decodeChannel("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self),
           status.configured,
           (status.running || status.probe?.ok == true)
        {
            return true
        }

        let fallback = self.consumerTelegramConfigFallback()
        return fallback.configured && fallback.lockedSenderId != nil
    }

    func consumerTelegramReadyForFirstTask() -> Bool {
        self.consumerTelegramLooksLive() && self.consumerTelegramFirstTaskVerified
    }

    private func consumerTelegramConfigFallback() -> ConsumerTelegramConfigFallback {
        guard AppFlavor.current.isConsumer else {
            return ConsumerTelegramConfigFallback(configured: false, lockedSenderId: nil)
        }

        // The consumer path should stay readable while the gateway is still
        // reconnecting. Fall back to the app-owned config instead of pretending
        // Telegram disappeared just because the last probe has not landed yet.
        let root = self.configDraft.isEmpty ? OpenClawConfigFile.loadDict() : self.configDraft
        let telegram = ((root["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let enabled = telegram["enabled"] as? Bool ?? false
        let token = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        let allowFrom = (telegram["allowFrom"] as? [String]) ?? []
        return ConsumerTelegramConfigFallback(
            configured: enabled && !token.isEmpty,
            lockedSenderId: allowFrom.first)
    }

    private func consumerTelegramConfiguredBotId() -> Int? {
        if let id = self.snapshot?
            .decodeChannel("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
            .probe?.bot?.id
        {
            return id
        }
        if let id = self.telegramSetupBotId {
            return id
        }

        // BotFather tokens start with the bot id before the colon. Persisting that
        // id lets us invalidate the "verified first task" marker when the user
        // swaps bots, without storing the secret token itself in UserDefaults.
        let token = TelegramSetupVerifier.normalizeToken(self.consumerTelegramConfiguredToken())
        guard let rawId = token.split(separator: ":").first,
              let botId = Int(rawId)
        else {
            return nil
        }
        return botId
    }

    private func consumerTelegramConfiguredToken() -> String {
        let draftRoot = self.configDraft.isEmpty ? OpenClawConfigFile.loadDict() : self.configDraft
        let telegram = ((draftRoot["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let configured = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        if !configured.isEmpty {
            return configured
        }
        return self.telegramSetupToken
    }
}
