import AppKit
import Foundation

extension ChannelsStore {
    func resetTelegramSetupProgressForEditedToken() {
        self.telegramSetupStatus = nil
        self.telegramSetupBotId = nil
        self.telegramSetupBotUsername = nil
        self.telegramSetupFirstSenderId = nil
        self.telegramSetupWaitingForDM = false
        self.telegramSetupPhase = .idle
    }

    func openTelegramSetupGuide() {
        guard let raw = AppFlavor.current.telegramSetupGuideURL else { return }
        self.openTelegramURL(raw)
    }

    func openTelegramSetupVideo() {
        guard let raw = AppFlavor.current.telegramSetupVideoURL else { return }
        self.openTelegramURL(raw)
    }

    func openTelegramBotFather() {
        self.openTelegramURL("https://t.me/BotFather")
    }

    func openTelegramBot(username: String) {
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        self.openTelegramURL("https://t.me/\(username)")
    }

    func verifyTelegramSetupToken() async {
        let token = TelegramSetupVerifier.normalizeToken(self.telegramSetupToken)
        guard !token.isEmpty else {
            self.telegramSetupStatus = "Paste your BotFather token first."
            return
        }
        self.telegramSetupToken = token

        // Verification should be fast and honest. Do not hide config bootstrap or
        // gateway recovery under the same "Checking Telegram..." state.
        guard !self.telegramBusy, self.telegramSetupPhase == .idle else { return }
        self.telegramBusy = true
        self.telegramSetupPhase = .verifyingToken
        defer {
            self.telegramBusy = false
            self.telegramSetupPhase = .idle
        }

        self.telegramSetupStatus = "Checking the token with Telegram..."
        do {
            let bot = try await TelegramSetupVerifier.verifyBot(token: token)
            self.telegramSetupBotId = bot.id
            self.telegramSetupBotUsername = bot.username
            self.telegramSetupStatus = self.telegramVerificationStatus(botUsername: bot.username)
        } catch {
            self.telegramSetupBotId = nil
            self.telegramSetupBotUsername = nil
            self.telegramSetupFirstSenderId = nil
            self.telegramSetupStatus = error.localizedDescription
        }
    }

    func captureTelegramFirstDirectMessage() async {
        let token = TelegramSetupVerifier.normalizeToken(self.telegramSetupToken)
        guard !token.isEmpty else {
            self.telegramSetupStatus = "Paste your BotFather token first."
            return
        }
        self.telegramSetupToken = token

        guard !self.telegramBusy, self.telegramSetupPhase == .idle else { return }
        self.telegramBusy = true
        self.telegramSetupPhase = .capturingFirstMessage
        self.telegramSetupWaitingForDM = true
        defer {
            self.telegramBusy = false
            self.telegramSetupPhase = .idle
        }

        self.telegramSetupStatus = "Waiting for the first message to the bot..."
        var pausedPollingProvider = false
        var restoredByFinalBootstrap = false
        do {
            pausedPollingProvider = try await self.pauseTelegramPollingForSetupIfNeeded(token: token)
            guard let dm = try await TelegramSetupVerifier.waitForFirstDirectMessage(token: token) else {
                self.telegramSetupWaitingForDM = false
                if pausedPollingProvider {
                    try? await self.restoreTelegramPairingAfterSetupPause(token: token)
                }
                self.telegramSetupStatus = TelegramSetupVerifierError.noDirectMessage.localizedDescription
                return
            }

            self.telegramSetupWaitingForDM = false
            self.telegramSetupStatus = "Saving Telegram setup..."
            self.telegramSetupPhase = .savingSetup
            let persisted = try await self.applyTelegramSetupBootstrap(
                token: token,
                dmPolicy: "allowlist",
                allowFrom: [String(dm.senderId)])
            restoredByFinalBootstrap = true
            self.telegramSetupFirstSenderId = String(dm.senderId)
            self.telegramSetupStatus = self.telegramCaptureStatus(
                dm: dm,
                persistedRoot: persisted)
        } catch {
            self.telegramSetupWaitingForDM = false
            if pausedPollingProvider && !restoredByFinalBootstrap {
                try? await self.restoreTelegramPairingAfterSetupPause(token: token)
            }
            self.telegramSetupStatus = error.localizedDescription
        }
    }

    func applyTelegramSetupBootstrap(
        token: String,
        dmPolicy: String,
        allowFrom: [String]?
    ) async throws -> [String: Any] {
        // Reload from the authoritative consumer config before editing so setup
        // cannot accidentally overwrite gateway/runtime keys with a stale empty draft.
        await self.restoreConfigDraftFromCurrentSource()
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("enabled")], value: true)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("botToken")], value: token)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("dmPolicy")], value: dmPolicy)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("groupPolicy")], value: "open")
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("allowFrom")], value: allowFrom)
        let persisted: [String: Any]
        if AppFlavor.current.isConsumer,
           !self.isPreview,
           AppStateStore.shared.connectionMode != .remote
        {
            persisted = await self.saveConfigDraftLocallyAndRefresh()
        } else {
            persisted = try await self.saveConfigDraftOrThrow()
        }
        try self.assertPersistedTelegramBootstrap(
            persistedRoot: persisted,
            dmPolicy: dmPolicy,
            allowFrom: allowFrom)
        Task { await self.refresh(probe: true) }
        return persisted
    }

    private func openTelegramURL(_ raw: String) {
        guard let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func telegramVerificationStatus(
        botUsername: String?
    ) -> String {
        return botUsername.map {
            "Token verified for @\($0). Now send the bot one message, then click Capture first message."
        } ?? "Token verified. Now send the bot one message, then click Capture first message."
    }

    private func telegramCaptureStatus(
        dm: TelegramSetupDirectMessage,
        persistedRoot: [String: Any]
    ) -> String {
        _ = persistedRoot
        return dm.senderUsername.map {
            "Locked to @\($0). For multiple parallel tasks, add the bot to a Telegram group and use topics."
        } ?? "Locked to Telegram user ID \(dm.senderId). For multiple parallel tasks, add the bot to a Telegram group and use topics."
    }

    private func assertPersistedTelegramBootstrap(
        persistedRoot: [String: Any],
        dmPolicy: String,
        allowFrom: [String]?
    ) throws {
        let telegram = ((persistedRoot["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let persistedPolicy = (telegram["dmPolicy"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard persistedPolicy == dmPolicy else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }

        let persistedAllowFrom = (telegram["allowFrom"] as? [String]) ?? []
        let expectedAllowFrom = allowFrom ?? []
        guard persistedAllowFrom == expectedAllowFrom else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
    }

    private func pauseTelegramPollingForSetupIfNeeded(token: String) async throws -> Bool {
        guard let status = self.snapshot?.decodeChannel(
            "telegram",
            as: ChannelsStatusSnapshot.TelegramStatus.self),
            status.running,
            status.mode == "polling"
        else {
            return false
        }

        await self.restoreConfigDraftFromCurrentSource()
        let telegram = ((self.configDraft["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let configuredToken = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        let enabled = telegram["enabled"] as? Bool ?? false

        guard enabled, configuredToken == token else {
            return false
        }

        // Setup uses direct getUpdates polling to capture the first DM. If the local
        // gateway is already polling the same bot token, Telegram returns a 409
        // conflict. Pause the consumer Telegram channel briefly, capture the DM, then
        // let the final bootstrap write re-enable it.
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("enabled")], value: false)
        _ = try await self.saveConfigDraftOrThrow()
        Task { await self.refresh(probe: true) }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        return true
    }

    private func restoreTelegramPairingAfterSetupPause(token: String) async throws {
        _ = try await self.applyTelegramSetupBootstrap(
            token: token,
            dmPolicy: "pairing",
            allowFrom: nil)
    }
}

private enum TelegramBootstrapPersistenceError: LocalizedError {
    case persistedConfigMismatch

    var errorDescription: String? {
        switch self {
        case .persistedConfigMismatch:
            "Telegram setup found your message, but OpenClaw could not persist the final config. Please try again."
        }
    }
}
