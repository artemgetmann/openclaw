import AppKit
import Foundation

extension ChannelsStore {
    private static let consumerDefaultTelegramAccountId = "default"

    func telegramRuntimeOwnershipIssue() -> String? {
        guard AppFlavor.current.isConsumer else { return nil }
        guard !self.isPreview else { return nil }
        return GatewayLaunchAgentManager.runtimeOwnershipBlockerMessage()
    }

    func resetTelegramSetupProgressForEditedToken() {
        self.clearConsumerTelegramFirstTaskVerified()
        self.telegramSetupStatus = nil
        self.telegramSetupBotId = nil
        self.telegramSetupBotUsername = nil
        self.telegramSetupFirstSenderId = nil
        self.telegramSetupBaselineInboundAt = nil
        self.telegramSetupBaselineOutboundAt = nil
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

        // Keep token verification separate from config writes. Users need to know
        // whether Telegram accepted the token before setup churns the local gateway.
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
            await self.refresh(probe: true)
            self.primeConsumerTelegramFirstTaskBaselineIfNeeded()
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

        self.telegramSetupStatus = "Waiting for your first Telegram task..."
        var pausedPollingProvider = false
        var restoredByFinalBootstrap = false
        do {
            pausedPollingProvider = try await self.pauseTelegramPollingForSetupIfNeeded(token: token)
            guard let dm = try await TelegramSetupVerifier.waitForFirstDirectMessage(token: token) else {
                self.telegramSetupWaitingForDM = false
                if pausedPollingProvider {
                    try? await self.restoreTelegramPairingAfterSetupPause(token: token)
                }
                if await self.consumerTelegramConfirmFirstTaskCompletionWithGrace() {
                    return
                }
                self.telegramSetupStatus = self.telegramCaptureFailureStatusAfterTimeout()
                    ?? TelegramSetupVerifierError.noDirectMessage.localizedDescription
                return
            }

            self.telegramSetupWaitingForDM = false
            self.telegramSetupStatus = "Saving Telegram setup..."
            self.telegramSetupPhase = .savingSetup
            // Track the exact inbound/outbound edge before replay. A single
            // activity max can miss real completion when Telegram timestamps are
            // coarse or when the reply happens in the same second as the DM.
            self.telegramSetupBaselineInboundAt = self.consumerTelegramLatestInboundAt()
                ?? Double(dm.date * 1_000)
            self.telegramSetupBaselineOutboundAt = self.consumerTelegramLatestOutboundAt()
            let persisted: [String: Any]
            if Self.consumerTelegramNeedsBootstrapBeforeReplay(
                pausedPollingProvider: pausedPollingProvider)
            {
                persisted = try await self.applyTelegramSetupBootstrap(
                    token: token,
                    dmPolicy: "allowlist",
                    allowFrom: [String(dm.senderId)],
                    enabled: false)
            } else {
                persisted = self.configRoot
            }
            self.telegramSetupFirstSenderId = String(dm.senderId)

            let activityAlreadyConfirmed = await self.consumerTelegramConfirmFirstTaskCompletionWithGrace()
            switch Self.consumerTelegramFirstTaskReplayAction(
                activityAlreadyConfirmed: activityAlreadyConfirmed)
            {
            case .trustObservedLiveCompletion:
                _ = try await self.applyTelegramSetupBootstrap(
                    token: token,
                    dmPolicy: "allowlist",
                    allowFrom: [String(dm.senderId)],
                    enabled: true)
                restoredByFinalBootstrap = true
                self.telegramSetupStatus = self.telegramCaptureStatus(
                    dm: dm,
                    persistedRoot: persisted,
                    replayResult: TelegramSetupReplayResult(
                        ok: true,
                        replyStarted: true,
                        replyCompleted: true,
                        error: nil),
                    activityConfirmed: true)
                return
            case .replayCapturedMessage:
                break
            }

            self.telegramSetupStatus = "Running your first Telegram task..."
            self.telegramSetupPhase = .startingFirstReply
            let replayResult = await self.startFirstTelegramReply(dm: dm)
            let replayDecision = Self.consumerTelegramReplayDecision(
                replyStarted: replayResult.replyStarted,
                replyCompleted: replayResult.replyCompleted,
                error: replayResult.error)
            if replayDecision.shouldReenableTelegram {
                _ = try await self.applyTelegramSetupBootstrap(
                    token: token,
                    dmPolicy: "allowlist",
                    allowFrom: [String(dm.senderId)],
                    enabled: true)
                restoredByFinalBootstrap = true
            } else if pausedPollingProvider {
                try? await self.restoreTelegramPairingAfterSetupPause(token: token)
                restoredByFinalBootstrap = true
            }

            let activityConfirmed = replayDecision.shouldWaitForActivityConfirmation
                ? await self.waitForConsumerTelegramFirstTaskActivityRefreshes()
                : false

            if replayDecision.shouldTrustReplayCompletion || activityConfirmed {
                self.markConsumerTelegramFirstTaskVerified()
            } else {
                self.clearConsumerTelegramFirstTaskVerified()
            }
            self.telegramSetupStatus = self.telegramCaptureStatus(
                dm: dm,
                persistedRoot: persisted,
                replayResult: replayResult,
                activityConfirmed: activityConfirmed)
        } catch {
            self.telegramSetupWaitingForDM = false
            self.clearConsumerTelegramFirstTaskVerified()
            if pausedPollingProvider && !restoredByFinalBootstrap {
                try? await self.restoreTelegramPairingAfterSetupPause(token: token)
            }
            self.telegramSetupStatus = error.localizedDescription
        }
    }

    func verifyConsumerTelegramFirstTask() async {
        if self.consumerTelegramLooksLive(),
           await self.consumerTelegramConfirmFirstTaskCompletionWithGrace()
        {
            return
        }

        await self.captureTelegramFirstDirectMessage()
    }

    func applyTelegramSetupBootstrap(
        token: String,
        dmPolicy: String,
        allowFrom: [String]?,
        enabled: Bool = true
    ) async throws -> [String: Any] {
        await self.restoreConfigDraftFromCurrentSource()
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("enabled")], value: enabled)
        self.updateConfigValue(
            path: [.key("channels"), .key("telegram"), .key("defaultAccount")],
            value: Self.consumerDefaultTelegramAccountId)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("botToken")], value: token)
        self.updateConfigValue(
            path: [.key("channels"), .key("telegram"), .key("accounts"), .key(Self.consumerDefaultTelegramAccountId), .key("botToken")],
            value: token)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("dmPolicy")], value: dmPolicy)
        self.updateConfigValue(path: [.key("tools"), .key("exec"), .key("security")], value: "full")
        self.updateConfigValue(path: [.key("tools"), .key("exec"), .key("ask")], value: "off")
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("groupPolicy")], value: "allowlist")
        self.updateConfigValue(
            path: [.key("channels"), .key("telegram"), .key("groups"), .key("*"), .key("requireMention")],
            value: false)
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
            allowFrom: allowFrom,
            enabled: enabled)
        await self.reconnectConsumerGatewayAfterConfigBootstrap()
        Task { await self.refresh(probe: true) }
        return persisted
    }

    private func openTelegramURL(_ raw: String) {
        guard let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func waitForConsumerTelegramFirstTaskActivityRefreshes(
        attempts: Int = 12,
        delayNanoseconds: UInt64 = 1_000_000_000,
        refresh: (() async -> Void)? = nil,
        sleep: @escaping (UInt64) async -> Void = { delay in
            try? await Task.sleep(nanoseconds: delay)
        }
    ) async -> Bool {
        for attempt in 0..<attempts {
            if let refresh {
                await refresh()
            } else {
                await self.refresh(probe: true)
            }
            if self.consumerTelegramLooksLive(),
               self.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible()
            {
                return true
            }
            guard attempt + 1 < attempts else { break }
            await sleep(delayNanoseconds)
        }

        return false
    }

    private func consumerTelegramConfirmFirstTaskCompletionWithGrace(
        attempts: Int = 12,
        delayNanoseconds: UInt64 = 1_000_000_000,
        refresh: (() async -> Void)? = nil,
        sleep: @escaping (UInt64) async -> Void = { delay in
            try? await Task.sleep(nanoseconds: delay)
        }
    ) async -> Bool {
        if self.completeConsumerTelegramFirstTaskVerificationFromActivityIfPossible() {
            return true
        }
        return await self.waitForConsumerTelegramFirstTaskActivityRefreshes(
            attempts: attempts,
            delayNanoseconds: delayNanoseconds,
            refresh: refresh,
            sleep: sleep)
    }

    private func telegramVerificationStatus(botUsername: String?) -> String {
        botUsername.map {
            "Token verified for @\($0). Now send your first task in Telegram, then click Verify first task."
        } ?? "Token verified. Now send your first task in Telegram, then click Verify first task."
    }

    private func telegramCaptureStatus(
        dm: TelegramSetupDirectMessage,
        persistedRoot: [String: Any],
        replayResult: TelegramSetupReplayResult,
        activityConfirmed: Bool
    ) -> String {
        _ = persistedRoot
        let replayCompleted = activityConfirmed
            || ((replayResult.replyCompleted ?? replayResult.replyStarted) && replayResult.error == nil)
        if replayCompleted {
            return dm.senderUsername.map {
                "Connected to @\($0). OpenClaw finished the first Telegram task on this Mac."
            } ?? "Telegram setup is finished. OpenClaw finished the first Telegram task on this Mac."
        }
        if let error = replayResult.error {
            return "Telegram setup is saved, but OpenClaw could not finish the first Telegram task. \(error)"
        }
        return "Telegram setup is saved, but OpenClaw could not confirm that the first Telegram task finished."
    }

    private func telegramCaptureFailureStatusAfterTimeout() -> String? {
        if let ownershipIssue = self.telegramRuntimeOwnershipIssue() {
            return ownershipIssue
        }
        if let status = self.snapshot?.decodeChannel(
            "telegram",
            as: ChannelsStatusSnapshot.TelegramStatus.self
        ) {
            if let conflict = self.consumerTelegramConflictMessage(status.lastError) {
                return conflict
            }
            if let conflict = self.consumerTelegramConflictMessage(status.probe?.error) {
                return conflict
            }
        }
        return nil
    }

    private func assertPersistedTelegramBootstrap(
        persistedRoot: [String: Any],
        dmPolicy: String,
        allowFrom: [String]?,
        enabled: Bool
    ) throws {
        let telegram = ((persistedRoot["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let persistedEnabled = telegram["enabled"] as? Bool ?? false
        guard persistedEnabled == enabled else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let persistedDefaultAccount = (telegram["defaultAccount"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard persistedDefaultAccount == Self.consumerDefaultTelegramAccountId else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let persistedAccounts = telegram["accounts"] as? [String: Any]
        let persistedDefault = persistedAccounts?[Self.consumerDefaultTelegramAccountId] as? [String: Any]
        let persistedToken = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        let persistedAccountToken = TelegramSetupVerifier.normalizeToken(
            (persistedDefault?["botToken"] as? String) ?? "")
        guard !persistedToken.isEmpty, persistedToken == persistedAccountToken else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let persistedPolicy = (telegram["dmPolicy"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard persistedPolicy == dmPolicy else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let tools = persistedRoot["tools"] as? [String: Any]
        let exec = tools?["exec"] as? [String: Any]
        let persistedExecSecurity = (exec?["security"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let persistedExecAsk = (exec?["ask"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard persistedExecSecurity == "full", persistedExecAsk == "off" else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let persistedGroupPolicy = (telegram["groupPolicy"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard persistedGroupPolicy == "allowlist" else {
            throw TelegramBootstrapPersistenceError.persistedConfigMismatch
        }
        let persistedGroups = telegram["groups"] as? [String: Any]
        let wildcardGroup = persistedGroups?["*"] as? [String: Any]
        let persistedRequireMention = wildcardGroup?["requireMention"] as? Bool
        guard persistedRequireMention == false else {
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
        let configuredToken = self.consumerConfiguredTelegramToken(in: telegram)
        let enabled = telegram["enabled"] as? Bool ?? false

        guard enabled, configuredToken == token else {
            return false
        }

        // Setup calls Telegram getUpdates directly. If the local gateway is
        // polling the same bot token, Telegram returns a 409 conflict. Pause the
        // channel briefly, capture the DM, then let final bootstrap re-enable it.
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("enabled")], value: false)
        if AppFlavor.current.isConsumer,
           !self.isPreview,
           AppStateStore.shared.connectionMode != .remote
        {
            _ = await self.saveConfigDraftLocallyAndRefresh()
        } else {
            _ = try await self.saveConfigDraftOrThrow()
        }
        Task { await self.refresh(probe: true) }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        return true
    }

    func consumerConfiguredTelegramToken(in telegram: [String: Any]) -> String {
        let legacyToken = TelegramSetupVerifier.normalizeToken((telegram["botToken"] as? String) ?? "")
        if !legacyToken.isEmpty {
            return legacyToken
        }
        let accounts = telegram["accounts"] as? [String: Any]
        let defaultAccount = accounts?[Self.consumerDefaultTelegramAccountId] as? [String: Any]
        return TelegramSetupVerifier.normalizeToken((defaultAccount?["botToken"] as? String) ?? "")
    }

    private func restoreTelegramPairingAfterSetupPause(token: String) async throws {
        _ = try await self.applyTelegramSetupBootstrap(
            token: token,
            dmPolicy: "pairing",
            allowFrom: nil)
    }

    private func startFirstTelegramReply(dm: TelegramSetupDirectMessage) async -> TelegramSetupReplayResult {
        guard let params = self.telegramReplayGatewayParams(dm: dm) else {
            return TelegramSetupReplayResult(
                ok: false,
                replyStarted: false,
                replyCompleted: false,
                error: "The captured first message did not contain text. Send one text message to begin.")
        }
        do {
            return try await GatewayConnection.shared.requestDecoded(
                method: .channelsTelegramSetupReplay,
                params: params,
                timeoutMs: 8_500)
        } catch {
            if Self.consumerTelegramReplayShouldRetryAfterRestart(error) {
                self.telegramSetupStatus = "Gateway restarting... retrying your first Telegram task."
                let recovered = await Self.recoverConsumerGatewayAfterConfigBootstrap(
                    shutdown: {
                        await GatewayConnection.shared.shutdown()
                    },
                    refreshEndpoint: {
                        await GatewayEndpointStore.shared.refresh()
                    },
                    refreshConnection: {
                        try await GatewayConnection.shared.refresh()
                    },
                    probe: {
                        _ = try await GatewayConnection.shared.requestRaw(
                            method: .status,
                            timeoutMs: 1_500)
                    })
                if recovered {
                    do {
                        return try await GatewayConnection.shared.requestDecoded(
                            method: .channelsTelegramSetupReplay,
                            params: params,
                            timeoutMs: 8_500)
                    } catch {
                        return TelegramSetupReplayResult(
                            ok: false,
                            replyStarted: false,
                            replyCompleted: false,
                            error: error.localizedDescription)
                    }
                }
            }
            return TelegramSetupReplayResult(
                ok: false,
                replyStarted: false,
                replyCompleted: false,
                error: error.localizedDescription)
        }
    }

    private func reconnectConsumerGatewayAfterConfigBootstrap() async {
        guard AppFlavor.current.isConsumer else { return }
        guard !self.isPreview else { return }
        guard AppStateStore.shared.connectionMode == .local else { return }

        _ = await Self.recoverConsumerGatewayAfterConfigBootstrap(
            shutdown: {
                await GatewayConnection.shared.shutdown()
            },
            refreshEndpoint: {
                await GatewayEndpointStore.shared.refresh()
            },
            refreshConnection: {
                try await GatewayConnection.shared.refresh()
            },
            probe: {
                _ = try await GatewayConnection.shared.requestRaw(
                    method: .status,
                    timeoutMs: 1_500)
            })
    }

    private static func recoverConsumerGatewayAfterConfigBootstrap(
        retryDelayNanoseconds: UInt64 = 350_000_000,
        maxAttempts: Int = 5,
        shutdown: @escaping @Sendable () async -> Void,
        refreshEndpoint: @escaping @Sendable () async -> Void,
        refreshConnection: @escaping @Sendable () async throws -> Void,
        probe: @escaping @Sendable () async throws -> Void,
        sleep: @escaping @Sendable (UInt64) async -> Void = { delay in
            try? await Task.sleep(nanoseconds: delay)
        }
    ) async -> Bool {
        for attempt in 0..<maxAttempts {
            await shutdown()
            await refreshEndpoint()
            do {
                try await refreshConnection()
                try await probe()
                return true
            } catch {
                guard attempt + 1 < maxAttempts else { break }
                await sleep(retryDelayNanoseconds)
            }
        }

        return false
    }

    private func telegramReplayGatewayParams(dm: TelegramSetupDirectMessage) -> [String: AnyCodable]? {
        let text = dm.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let caption = dm.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (text?.isEmpty == false) || (caption?.isEmpty == false) else {
            return nil
        }
        // Keep integer fields as Swift Int values. JSONSerialization-style bridges
        // can turn them into doubles, which the gateway setup-replay schema rejects.
        var object: [String: AnyCodable] = [
            "updateId": AnyCodable(dm.updateId),
            "messageId": AnyCodable(dm.messageId),
            "chatId": AnyCodable(Int(dm.chatId)),
            "senderId": AnyCodable(dm.senderId),
            "date": AnyCodable(dm.date),
        ]
        if let chatUsername = dm.chatUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
           !chatUsername.isEmpty
        {
            object["chatUsername"] = AnyCodable(chatUsername)
        }
        if let senderUsername = dm.senderUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
           !senderUsername.isEmpty
        {
            object["senderUsername"] = AnyCodable(senderUsername)
        }
        if let senderFirstName = dm.senderFirstName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !senderFirstName.isEmpty
        {
            object["senderFirstName"] = AnyCodable(senderFirstName)
        }
        if let text, !text.isEmpty {
            object["text"] = AnyCodable(text)
        }
        if let caption, !caption.isEmpty {
            object["caption"] = AnyCodable(caption)
        }
        if let messageThreadId = dm.messageThreadId {
            object["messageThreadId"] = AnyCodable(messageThreadId)
        }
        return [
            "payload": AnyCodable(object.mapValues(\.value)),
            "timeoutMs": AnyCodable(8_000),
        ]
    }
}

struct ConsumerTelegramReplayDecision: Equatable {
    let shouldReenableTelegram: Bool
    let shouldWaitForActivityConfirmation: Bool
    let shouldTrustReplayCompletion: Bool
}

enum ConsumerTelegramFirstTaskReplayAction: Equatable {
    case replayCapturedMessage
    case trustObservedLiveCompletion
}

extension ChannelsStore {
    static func consumerTelegramReplayDecision(
        replyStarted: Bool,
        replyCompleted: Bool?,
        error: String?
    ) -> ConsumerTelegramReplayDecision {
        let completed = replyCompleted ?? replyStarted
        if error == nil {
            return ConsumerTelegramReplayDecision(
                shouldReenableTelegram: true,
                shouldWaitForActivityConfirmation: !completed,
                shouldTrustReplayCompletion: completed)
        }

        if replyStarted {
            return ConsumerTelegramReplayDecision(
                shouldReenableTelegram: true,
                shouldWaitForActivityConfirmation: true,
                shouldTrustReplayCompletion: false)
        }

        return ConsumerTelegramReplayDecision(
            shouldReenableTelegram: false,
            shouldWaitForActivityConfirmation: false,
            shouldTrustReplayCompletion: false)
    }

    static func consumerTelegramFirstTaskReplayAction(
        activityAlreadyConfirmed: Bool
    ) -> ConsumerTelegramFirstTaskReplayAction {
        activityAlreadyConfirmed ? .trustObservedLiveCompletion : .replayCapturedMessage
    }

    static func consumerTelegramNeedsBootstrapBeforeReplay(
        pausedPollingProvider: Bool
    ) -> Bool {
        !pausedPollingProvider
    }

    static func consumerTelegramReplayShouldRetryAfterRestart(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("socket is not connected")
            || message.contains("gateway connection dropped")
            || message.contains("abnormal closure")
    }
}

#if DEBUG
extension ChannelsStore {
    func _testConsumerTelegramConfirmFirstTaskCompletionWithGrace(
        attempts: Int = 12,
        delayNanoseconds: UInt64 = 1_000_000_000,
        refresh: (() async -> Void)? = nil,
        sleep: @escaping (UInt64) async -> Void = { _ in }
    ) async -> Bool {
        await self.consumerTelegramConfirmFirstTaskCompletionWithGrace(
            attempts: attempts,
            delayNanoseconds: delayNanoseconds,
            refresh: refresh,
            sleep: sleep)
    }

    static func _testRecoverConsumerGatewayAfterConfigBootstrap(
        retryDelayNanoseconds: UInt64 = 350_000_000,
        maxAttempts: Int = 5,
        shutdown: @escaping @Sendable () async -> Void,
        refreshEndpoint: @escaping @Sendable () async -> Void,
        refreshConnection: @escaping @Sendable () async throws -> Void,
        probe: @escaping @Sendable () async throws -> Void,
        sleep: @escaping @Sendable (UInt64) async -> Void = { _ in }
    ) async -> Bool {
        await Self.recoverConsumerGatewayAfterConfigBootstrap(
            retryDelayNanoseconds: retryDelayNanoseconds,
            maxAttempts: maxAttempts,
            shutdown: shutdown,
            refreshEndpoint: refreshEndpoint,
            refreshConnection: refreshConnection,
            probe: probe,
            sleep: sleep)
    }
}
#endif

private enum TelegramBootstrapPersistenceError: LocalizedError {
    case persistedConfigMismatch

    var errorDescription: String? {
        switch self {
        case .persistedConfigMismatch:
            "Telegram setup found your message, but OpenClaw could not persist the final config. Please try again."
        }
    }
}

private struct TelegramSetupReplayResult: Decodable {
    let ok: Bool
    let replyStarted: Bool
    let replyCompleted: Bool?
    let error: String?
}

#if DEBUG
extension ChannelsStore {
    func _testTelegramReplayGatewayParams(dm: TelegramSetupDirectMessage) -> [String: AnyCodable]? {
        self.telegramReplayGatewayParams(dm: dm)
    }
}
#endif
