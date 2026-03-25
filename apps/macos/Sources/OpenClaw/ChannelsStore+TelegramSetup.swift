import AppKit
import Foundation

extension ChannelsStore {
    static let consumerTelegramBotUsernameDefaultsKey = "OpenClawConsumerTelegramBotUsername"

    func telegramRuntimeOwnershipIssue() -> String? {
        guard AppFlavor.current.isConsumer else { return nil }
        guard !self.isPreview else { return nil }
        return GatewayLaunchAgentManager.runtimeOwnershipBlockerMessage()
    }

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
            if let username = bot.username, !username.isEmpty {
                UserDefaults.standard.set(
                    username,
                    forKey: Self.consumerTelegramBotUsernameDefaultsKey)
            }
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
        if let ownershipIssue = self.telegramRuntimeOwnershipIssue() {
            self.telegramSetupStatus = ownershipIssue
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
            self.telegramSetupStatus = "Starting the first reply in Telegram..."
            self.telegramSetupPhase = .startingFirstReply
            let replayResult = await self.startFirstTelegramReply(dm: dm)
            self.telegramSetupStatus = self.telegramCaptureStatus(
                dm: dm,
                persistedRoot: persisted,
                replayResult: replayResult)
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
        persistedRoot: [String: Any],
        replayResult: TelegramSetupReplayResult
    ) -> String {
        _ = persistedRoot
        if let error = replayResult.error {
            return "Telegram setup is finished, but OpenClaw could not start the first reply automatically. \(error)"
        }
        if !replayResult.replyStarted {
            return "Telegram setup is finished, but OpenClaw could not confirm that the first reply started."
        }
        if AppFlavor.current.isConsumer {
            return dm.senderUsername.map {
                "Connected to @\($0). Your AI operator has started the first reply in Telegram."
            } ?? "Telegram setup is finished. Your AI operator has started the first reply in Telegram."
        }
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

    private func startFirstTelegramReply(dm: TelegramSetupDirectMessage) async -> TelegramSetupReplayResult {
        // The first DM must go through the same Telegram inbound pipeline the real
        // gateway uses. Otherwise setup "works" but the first reply path is still fake.
        guard let payload = self.telegramReplayPayloadJson(dm: dm) else {
            return TelegramSetupReplayResult(
                ok: false,
                replyStarted: false,
                error: "The captured first message did not contain text. Send one text message to begin.")
        }

        let command = CommandResolver.openclawCommand(
            subcommand: "channels",
            extraArgs: ["telegram-replay-setup-dm", "--payload-json", payload, "--json"],
            configRoot: ["gateway": ["mode": "local"]])
        let env = GatewayLaunchAgentManager.daemonCommandEnvironment(
            base: ProcessInfo.processInfo.environment,
            projectRootHint: CommandResolver.projectRootEnvironmentHint())
        let response = await ShellExecutor.runDetailed(command: command, cwd: nil, env: env, timeout: 90)
        if !response.success {
            let detail = response.stderr.nonEmpty ?? response.stdout.nonEmpty ?? response.errorMessage ?? "unknown error"
            return TelegramSetupReplayResult(ok: false, replyStarted: false, error: detail)
        }

        let raw = response.stdout.isEmpty ? response.stderr : response.stdout
        guard let data = raw.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(TelegramSetupReplayResult.self, from: data)
        else {
            return TelegramSetupReplayResult(
                ok: false,
                replyStarted: false,
                error: "OpenClaw started the handoff, but returned an unreadable response.")
        }
        return parsed
    }

    private func telegramReplayPayloadJson(dm: TelegramSetupDirectMessage) -> String? {
        let text = dm.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let caption = dm.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (text?.isEmpty == false) || (caption?.isEmpty == false) else {
            return nil
        }
        let payload = TelegramSetupReplayPayload(
            updateId: dm.updateId,
            messageId: dm.messageId,
            chatId: dm.chatId,
            chatUsername: dm.chatUsername,
            senderId: dm.senderId,
            senderUsername: dm.senderUsername,
            senderFirstName: dm.senderFirstName,
            text: text?.isEmpty == false ? text : nil,
            caption: caption?.isEmpty == false ? caption : nil,
            date: dm.date,
            messageThreadId: dm.messageThreadId)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return json
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

private struct TelegramSetupReplayPayload: Encodable {
    let updateId: Int
    let messageId: Int
    let chatId: Int64
    let chatUsername: String?
    let senderId: Int
    let senderUsername: String?
    let senderFirstName: String?
    let text: String?
    let caption: String?
    let date: Int
    let messageThreadId: Int?
}

private struct TelegramSetupReplayResult: Decodable {
    let ok: Bool
    let replyStarted: Bool
    let error: String?
}
