import Foundation

private struct ConsumerTelegramConfigFallback {
    let configured: Bool
    let lockedSenderId: String?
}

extension ChannelsStore {
    static let consumerTelegramBotUsernameDefaultsKey = "OpenClawConsumerTelegramBotUsername"
    private static let consumerTelegramFirstTaskActivityRecencyWindow: Double = 24 * 60 * 60

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
        UserDefaults.standard.set(botId, forKey: Self.consumerTelegramFirstTaskVerificationDefaultsKey())
    }

    func clearConsumerTelegramFirstTaskVerified() {
        UserDefaults.standard.removeObject(forKey: Self.consumerTelegramFirstTaskVerificationDefaultsKey())
    }

    private func consumerTelegramPrimaryAccount() -> ChannelsStatusSnapshot.ChannelAccountSnapshot? {
        self.snapshot?.channelAccounts["telegram"]?
            .first(where: { ($0.accountId == "default") || ($0.accountId == self.snapshot?.channelDefaultAccountId["telegram"]) })
    }

    func consumerTelegramLatestInboundAt() -> Double? {
        self.consumerTelegramPrimaryAccount()?.lastInboundAt
    }

    func consumerTelegramLatestOutboundAt() -> Double? {
        self.consumerTelegramPrimaryAccount()?.lastOutboundAt
    }

    func consumerTelegramLatestActivityAt() -> Double? {
        max(
            self.consumerTelegramLatestInboundAt() ?? 0,
            self.consumerTelegramLatestOutboundAt() ?? 0)
    }

    func primeConsumerTelegramFirstTaskBaselineIfNeeded() {
        guard self.telegramSetupBaselineInboundAt == nil,
              self.telegramSetupBaselineOutboundAt == nil
        else { return }
        // Track inbound and outbound edges independently. A DM and bot reply can
        // land in the same Telegram second, so one max(activity) timestamp is too
        // lossy for first-task verification.
        self.telegramSetupBaselineInboundAt = self.consumerTelegramLatestInboundAt()
        self.telegramSetupBaselineOutboundAt = self.consumerTelegramLatestOutboundAt()
    }

    private func consumerTelegramNormalizeTimestamp(_ value: Double) -> Double {
        // Gateway snapshots can surface timestamps in seconds or milliseconds.
        // Normalize both shapes so the verification rule stays conservative
        // without becoming format-sensitive.
        value > 10_000_000_000 ? value / 1_000 : value
    }

    private func consumerTelegramHasRecentPairedActivity(
        inboundAt: Double,
        outboundAt: Double
    ) -> Bool {
        let inbound = self.consumerTelegramNormalizeTimestamp(inboundAt)
        let outbound = self.consumerTelegramNormalizeTimestamp(outboundAt)
        guard outbound >= inbound else { return false }

        // Require the user DM and bot reply to land close together. This keeps
        // stale historical traffic from auto-promoting a fresh setup screen.
        guard outbound - inbound <= Self.consumerTelegramFirstTaskActivityRecencyWindow else {
            return false
        }

        if let snapshotAt = self.snapshot?.ts {
            let snapshot = self.consumerTelegramNormalizeTimestamp(snapshotAt)
            guard snapshot >= outbound else { return false }
            return snapshot - outbound <= Self.consumerTelegramFirstTaskActivityRecencyWindow
        }

        return true
    }

    func consumerTelegramCanVerifyFirstTaskFromActivity() -> Bool {
        let latestInboundAt = self.consumerTelegramLatestInboundAt()
        let latestOutboundAt = self.consumerTelegramLatestOutboundAt()

        if let baselineInboundAt = self.telegramSetupBaselineInboundAt,
           let baselineOutboundAt = self.telegramSetupBaselineOutboundAt,
           let latestInboundAt,
           let latestOutboundAt
        {
            let inboundAdvanced = latestInboundAt > baselineInboundAt
            let outboundAdvanced = latestOutboundAt > baselineOutboundAt
            if inboundAdvanced || outboundAdvanced {
                return true
            }
        } else if self.telegramSetupBaselineOutboundAt == nil,
                  let baselineInboundAt = self.telegramSetupBaselineInboundAt,
                  let latestActivityAt = self.consumerTelegramLatestActivityAt(),
                  latestActivityAt > baselineInboundAt
        {
            return true
        }

        guard let latestInboundAt, let latestOutboundAt else { return false }
        return self.consumerTelegramHasRecentPairedActivity(
            inboundAt: latestInboundAt,
            outboundAt: latestOutboundAt)
    }

    @discardableResult
    func completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible() -> Bool {
        guard self.consumerTelegramCanVerifyFirstTaskFromActivity() else { return false }

        // If the live poller already handled the first DM/reply, trust observed
        // Telegram activity instead of forcing the user to send a duplicate setup
        // message just to satisfy local UI state.
        self.markConsumerTelegramFirstTaskVerified()
        self.telegramSetupWaitingForDM = false
        self.telegramSetupPhase = .idle
        if self.telegramSetupFirstSenderId == nil {
            self.telegramSetupFirstSenderId = self.consumerTelegramConfigFallback().lockedSenderId
        }
        self.telegramSetupStatus = self.consumerTelegramBotUsername().map {
            "Telegram bot is live as @\($0). First task verified."
        } ?? "Telegram bot is live. First task verified."
        return true
    }

    @discardableResult
    func completeConsumerTelegramFirstTaskVerificationForResumeIfSafe() -> Bool {
        guard self.consumerTelegramLooksLive() else { return false }
        guard self.consumerTelegramConfiguredBotId() != nil else { return false }
        guard !self.consumerTelegramFirstTaskVerified else { return true }

        // Existing users may have a healthy bot and a locked sender from before
        // the local first-task marker existed. Promote only when live runtime
        // state plus sender/account evidence proves this is an already-used bot,
        // not a half-pasted BotFather token.
        let fallback = self.consumerTelegramConfigFallback()
        let account = self.consumerTelegramPrimaryAccount()
        let hasSenderEvidence =
            fallback.lockedSenderId != nil ||
            self.telegramSetupFirstSenderId != nil ||
            account?.allowFrom?.isEmpty == false
        let hasActivityEvidence = self.consumerTelegramCanVerifyFirstTaskFromActivity()
        guard hasSenderEvidence || hasActivityEvidence else { return false }

        self.markConsumerTelegramFirstTaskVerified()
        self.telegramSetupWaitingForDM = false
        self.telegramSetupPhase = .idle
        if self.telegramSetupFirstSenderId == nil {
            self.telegramSetupFirstSenderId = fallback.lockedSenderId ?? account?.allowFrom?.first
        }
        self.telegramSetupStatus = self.consumerTelegramBotUsername().map {
            "Telegram bot is live as @\($0). First task verified from existing setup."
        } ?? "Telegram bot is live. First task verified from existing setup."
        return true
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
            return "This bot is already active somewhere else on this Mac. Close the other Jarvis window or use a different bot token."
        }
        return nil
    }

    func consumerTelegramAccessGateMessage(_ raw: String?) -> String? {
        guard AppFlavor.current.isConsumer else { return nil }
        guard self.telegramSetupFirstSenderId != nil else { return nil }
        guard !self.telegramSetupWaitingForDM else { return nil }

        let normalized = raw?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        guard normalized.hasPrefix("telegram setup is saved, but openclaw could not finish the first telegram task")
            || normalized.hasPrefix("telegram setup is saved, but openclaw could not confirm that the first telegram task finished")
        else {
            return nil
        }
        guard self.consumerTelegramLooksLive() else { return nil }

        return "Telegram is approved. Send one more message to Jarvis, then Verify Telegram again."
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
        let persisted = UserDefaults.standard.string(forKey: Self.consumerTelegramBotUsernameDefaultsKey)
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

        // BotFather tokens start with the bot id before the colon. Persisting
        // only that id invalidates "first task verified" when the user swaps bots
        // without storing the secret in UserDefaults.
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
