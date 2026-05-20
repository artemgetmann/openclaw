import AppKit
import Foundation

extension ChannelsStore {
    private static let consumerDefaultTelegramAccountId = "default"
    private static let consumerTelegramFirstTaskText = "Wake up my friend!"
    private static let consumerTelegramRuntimePluginAllowlist = ["telegram", "anthropic", "openai"]

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
        self.telegramManagedSetupId = nil
        self.telegramManagedApprovalURL = nil
        self.telegramManagedSuggestedBotUsername = nil
        self.telegramManagedExpiresAt = nil
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

    func openTelegramManagedApproval() {
        guard let approvalURL = self.telegramManagedApprovalURL else { return }
        self.openTelegramURL(approvalURL)
    }

    func startManagedTelegramSetup() async {
        guard !self.telegramBusy, self.telegramSetupPhase == .idle else { return }
        self.telegramBusy = true
        self.telegramSetupPhase = .startingManagedBot
        defer {
            self.telegramBusy = false
            self.telegramSetupPhase = .idle
        }

        self.telegramSetupStatus = "Creating your Telegram bot..."
        do {
            let configuration = try self.managedTelegramBotConfiguration()
            guard configuration.accountAccessToken?.isEmpty == false else {
                self.telegramSetupStatus = "Activate Jarvis before creating a managed Telegram bot."
                return
            }
            let client = JarvisTelegramManagedBotClient(configuration: configuration)
            let response = try await client.start(suggestedBotName: "\(AppFlavor.current.appName) Assistant")
            self.telegramManagedSetupId = response.setupId
            self.telegramManagedApprovalURL = response.approvalUrl
            self.telegramManagedSuggestedBotUsername = response.suggestedBotUsername
            self.telegramManagedExpiresAt = response.expiresAt
            self.telegramSetupStatus = self.managedTelegramApprovalStatus(
                suggestedUsername: response.suggestedBotUsername)
            self.openTelegramURL(response.approvalUrl)
        } catch {
            self.handleManagedTelegramSetupStatusError(error)
        }
    }

    func checkManagedTelegramSetupStatus() async {
        guard !self.telegramBusy, self.telegramSetupPhase == .idle else { return }
        guard let setupId = self.telegramManagedSetupId else {
            self.telegramSetupStatus = "Create the bot first, then approve it in Telegram."
            return
        }

        self.telegramBusy = true
        self.telegramSetupPhase = .checkingManagedApproval
        defer {
            self.telegramBusy = false
            self.telegramSetupPhase = .idle
        }

        self.telegramSetupStatus = "Checking Telegram approval..."
        do {
            let client = try self.managedTelegramBotClient()
            let response = try await self.pollManagedTelegramSetupStatus(
                client: client,
                setupId: setupId,
                attempts: 1)
            self.telegramManagedSuggestedBotUsername = response.suggestedBotUsername
            self.telegramManagedExpiresAt = response.expiresAt
            guard response.status == "connected" else {
                self.telegramSetupStatus = self.managedTelegramPendingStatus(
                    suggestedUsername: response.suggestedBotUsername)
                return
            }
            guard let token = response.managedChildBotToken.map(TelegramSetupVerifier.normalizeToken),
                  !token.isEmpty
            else {
                self.telegramSetupStatus = "Telegram approved the bot, but Jarvis could not finish setup. Try again."
                return
            }

            self.telegramSetupPhase = .installingManagedBot
            self.telegramSetupToken = token
            self.telegramSetupBotId = response.botId
            self.telegramSetupBotUsername = response.botUsername ?? response.suggestedBotUsername
            if let username = self.telegramSetupBotUsername, !username.isEmpty {
                UserDefaults.standard.set(
                    username,
                    forKey: Self.consumerTelegramBotUsernameDefaultsKey)
            }
            _ = try await self.applyTelegramSetupBootstrap(
                token: token,
                dmPolicy: "pairing",
                allowFrom: nil,
                enabled: true)
            self.primeConsumerTelegramFirstTaskBaselineIfNeeded()
            self.telegramSetupStatus = self.managedTelegramConnectedStatus(
                botUsername: self.telegramSetupBotUsername)
        } catch {
            self.telegramSetupStatus = error.localizedDescription
        }
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
            if try await self.approvePendingTelegramPairingForFirstTaskIfAvailable(token: token) {
                return
            }

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
        self.updateConfigValue(path: [.key("plugins"), .key("enabled")], value: true)
        self.updateConfigValue(path: [.key("plugins"), .key("allow")], value: Self.consumerTelegramRuntimePluginAllowlist)
        self.updateConfigValue(path: [.key("plugins"), .key("deny")], value: ["acpx", "diffs"])
        self.updateConfigValue(path: [.key("plugins"), .key("slots"), .key("memory")], value: "none")
        self.updateConfigValue(path: [.key("plugins"), .key("entries"), .key("telegram"), .key("enabled")], value: true)
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
            "Token verified for @\($0). Click Verify first task to approve sender access."
        } ?? "Token verified. Click Verify first task to approve sender access."
    }

    private func managedTelegramBotClient() throws -> JarvisTelegramManagedBotClient {
        try JarvisTelegramManagedBotClient(configuration: self.managedTelegramBotConfiguration())
    }

    private func managedTelegramBotConfiguration() throws -> JarvisTelegramManagedBotClient.Configuration {
        let config = self.configRoot.isEmpty ? OpenClawConfigFile.loadDict() : self.configRoot
        return try JarvisTelegramManagedBotClient.resolveConfiguration(root: config)
    }

    private func pollManagedTelegramSetupStatus(
        client: JarvisTelegramManagedBotClient,
        setupId: String,
        attempts: Int = 8,
        delayNanoseconds: UInt64 = 1_500_000_000
    ) async throws -> JarvisTelegramManagedStatusResponse {
        var latest: JarvisTelegramManagedStatusResponse?
        for attempt in 0..<attempts {
            let response = try await client.status(setupId: setupId)
            latest = response
            if response.status == "connected" {
                return response
            }

            // Some callers may intentionally wait briefly for Telegram's
            // manager-bot webhook. The visible Check status button passes one
            // attempt so the UI never looks stuck while still pending.
            guard attempt + 1 < attempts else { break }
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }

        if let latest {
            return latest
        }
        return try await client.status(setupId: setupId)
    }

    private func managedTelegramApprovalStatus(suggestedUsername: String) -> String {
        "Telegram is opening. Approve @\(suggestedUsername), use Jarvis or edit the bot name, click Create, then come back and check status."
    }

    private func managedTelegramPendingStatus(suggestedUsername: String) -> String {
        "Still waiting for Telegram approval for @\(suggestedUsername). In Telegram, approve it, use Jarvis or edit the bot name, click Create, then check again."
    }

    private func managedTelegramConnectedStatus(botUsername: String?) -> String {
        botUsername.map {
            "@\($0) is ready. Click Verify first task to approve sender access."
        } ?? "Your Telegram bot is ready. Click Verify first task to approve sender access."
    }

    private func approvePendingTelegramPairingForFirstTaskIfAvailable(token: String) async throws -> Bool {
        guard let pending = Self.latestPendingTelegramPairingRequest() else { return false }

        self.telegramSetupFirstSenderId = pending.id
        self.telegramSetupBaselineInboundAt = self.consumerTelegramLatestInboundAt()
        self.telegramSetupBaselineOutboundAt = self.consumerTelegramLatestOutboundAt()
        self.telegramSetupStatus = "Approving Telegram access for your first DM..."

        _ = try await self.applyTelegramSetupBootstrap(
            token: token,
            dmPolicy: "allowlist",
            allowFrom: [pending.id],
            enabled: true)

        self.telegramSetupWaitingForDM = true
        self.telegramSetupStatus = "Access approved. Now send \"\(Self.consumerTelegramFirstTaskText)\" to the bot in Telegram."
        if await self.waitForConsumerTelegramFirstTaskActivityRefreshes(
            attempts: 45,
            delayNanoseconds: 1_000_000_000)
        {
            self.telegramSetupWaitingForDM = false
            return true
        }

        self.telegramSetupWaitingForDM = false
        self.clearConsumerTelegramFirstTaskVerified()
        self.telegramSetupStatus = "Telegram access is approved. Send \"\(Self.consumerTelegramFirstTaskText)\" as a new DM, then click Verify first task again."
        return true
    }

    private func handleManagedTelegramSetupStatusError(_ error: Error) {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)

        // The backend keeps managed setup records short-lived. Once it no
        // longer recognizes a setup id, the app has no child-bot token to save.
        // Clear transient state so Verify first task cannot run against a stale
        // token from a previous attempt.
        if Self.managedTelegramSetupWasLost(message) {
            self.telegramManagedSetupId = nil
            self.telegramManagedApprovalURL = nil
            self.telegramManagedExpiresAt = nil
            self.telegramSetupToken = ""
            self.telegramSetupBotId = nil
            self.telegramSetupBotUsername = nil
            self.telegramSetupStatus = "Telegram approval expired before Jarvis saved the bot. Create a new Telegram bot, tap Start in Telegram, then check status."
            return
        }

        self.telegramSetupStatus = message.isEmpty ? error.localizedDescription : message
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
                "Connected to @\($0). \(AppFlavor.current.appName) finished the first Telegram task on this Mac."
            } ?? "Telegram setup is finished. \(AppFlavor.current.appName) finished the first Telegram task on this Mac."
        }
        if let error = replayResult.error {
            let visibleError = Self.consumerTelegramFirstTaskReplayStatusMessage(for: error)
                ?? "Telegram setup is saved, but \(AppFlavor.current.appName) could not finish the first Telegram task. \(error)"
            return visibleError
        }
        return "Telegram setup is saved, but \(AppFlavor.current.appName) could not confirm that the first Telegram task finished."
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
        let plugins = persistedRoot["plugins"] as? [String: Any]
        let pluginAllow = (plugins?["allow"] as? [String]) ?? []
        let pluginSlots = plugins?["slots"] as? [String: Any]
        let pluginEntries = plugins?["entries"] as? [String: Any]
        let telegramPluginEntry = pluginEntries?["telegram"] as? [String: Any]
        guard plugins?["enabled"] as? Bool == true,
              pluginAllow == Self.consumerTelegramRuntimePluginAllowlist,
              (plugins?["deny"] as? [String]) == ["acpx", "diffs"],
              pluginSlots?["memory"] as? String == "none",
              telegramPluginEntry?["enabled"] as? Bool == true
        else {
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
        await self.restoreConfigDraftFromCurrentSource()
        let telegram = ((self.configDraft["channels"] as? [String: Any])?["telegram"] as? [String: Any]) ?? [:]
        let configuredToken = self.consumerConfiguredTelegramToken(in: telegram)
        let enabled = telegram["enabled"] as? Bool ?? false

        guard enabled, configuredToken == token else {
            return false
        }

        // Setup calls Telegram getUpdates directly. If the local gateway is, or
        // recently was, polling the same bot token, Telegram can return a 409
        // conflict. Pause from config truth instead of relying on a fresh
        // channel snapshot; the snapshot can be stale during the managed-bot
        // install restart, exactly when first-task verification begins.
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
        try await Task.sleep(nanoseconds: 2_500_000_000)
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

    static func consumerTelegramFirstTaskReplayStatusMessage(for error: String) -> String? {
        let message = error.lowercased()
        let looksLikeLocalRuntimePlumbing = message.contains("ws://127.0.0.1")
            || message.contains("ws://localhost")
            || message.contains("127.0.0.1")
            || message.contains("localhost")
            || message.contains("socket is not connected")
            || message.contains("connection refused")
            || message.contains("could not connect")
            || message.contains("cannot connect")
            || message.contains("network connection was lost")

        // The setup token and sender allowlist are already saved at this point.
        // A local websocket failure means Jarvis is not reachable, not that the
        // user made a Telegram mistake. Keep raw gateway URLs out of the UI.
        guard looksLikeLocalRuntimePlumbing else { return nil }
        return "Telegram setup is saved, but \(AppFlavor.current.appName) could not finish the first task because the local \(AppFlavor.current.appName) runtime is not reachable. Start or open \(AppFlavor.current.appName), then try Verify first task again."
    }

    static func managedTelegramSetupWasLost(_ message: String) -> Bool {
        let normalized = message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalized.isEmpty else { return false }
        return normalized.contains("telegram setup not found")
            || normalized.contains("managed setup not found")
            || normalized.contains("setup not found")
    }

    static func latestPendingTelegramPairingRequest(
        now: Date = Date(),
        stateDirURL: URL = OpenClawPaths.stateDirURL
    ) -> ConsumerTelegramPendingPairingRequest? {
        let url = stateDirURL
            .appendingPathComponent("credentials", isDirectory: true)
            .appendingPathComponent("telegram-pairing.json")
        guard let data = try? Data(contentsOf: url),
              let store = try? JSONDecoder().decode(ConsumerTelegramPairingStore.self, from: data)
        else {
            return nil
        }

        // The first DM can arrive while Jarvis is still in pairing mode, then
        // the operator may spend time relaunching the isolated smoke app or
        // approving BotFather. Keep that pending sender long enough for the
        // setup proof without turning old pairing attempts into permanent trust.
        let maxAge: TimeInterval = 6 * 60 * 60
        return store.requests
            .filter { request in
                guard request.id.range(of: #"^\d+$"#, options: .regularExpression) != nil else {
                    return false
                }
                let accountId = request.meta?["accountId"]?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased() ?? Self.consumerDefaultTelegramAccountId
                guard accountId == Self.consumerDefaultTelegramAccountId else { return false }
                let createdAt = Self.consumerTelegramPairingDate(request.createdAt)
                let lastSeenAt = Self.consumerTelegramPairingDate(request.lastSeenAt) ?? createdAt
                guard let reference = lastSeenAt ?? createdAt else { return false }
                return now.timeIntervalSince(reference) <= maxAge
            }
            .sorted { lhs, rhs in
                let lhsDate = Self.consumerTelegramPairingDate(lhs.lastSeenAt)
                    ?? Self.consumerTelegramPairingDate(lhs.createdAt)
                    ?? .distantPast
                let rhsDate = Self.consumerTelegramPairingDate(rhs.lastSeenAt)
                    ?? Self.consumerTelegramPairingDate(rhs.createdAt)
                    ?? .distantPast
                return lhsDate > rhsDate
            }
            .first
    }

    private static func consumerTelegramPairingDate(_ raw: String) -> Date? {
        // Telegram pairing requests are written by the Node runtime. Newer
        // writes include fractional seconds, while older test fixtures and
        // hand-authored recovery files may not. Accept both shapes so first-task
        // recovery does not silently miss a real DM that already reached the
        // isolated gateway.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) {
            return date
        }
        return ISO8601DateFormatter().date(from: raw)
    }
}

struct ConsumerTelegramPendingPairingRequest: Decodable, Equatable {
    let id: String
    let code: String
    let createdAt: String
    let lastSeenAt: String
    let meta: [String: String]?
}

private struct ConsumerTelegramPairingStore: Decodable {
    let version: Int
    let requests: [ConsumerTelegramPendingPairingRequest]
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
            "Telegram setup found your message, but \(AppFlavor.current.appName) could not persist the final config. Please try again."
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

    func _testHandleManagedTelegramSetupStatusErrorMessage(_ message: String) {
        let error = NSError(
            domain: "ManagedTelegramSetup",
            code: 404,
            userInfo: [NSLocalizedDescriptionKey: message])
        self.handleManagedTelegramSetupStatusError(error)
    }

    static func _testLatestPendingTelegramPairingRequest(
        now: Date,
        stateDirURL: URL
    ) -> ConsumerTelegramPendingPairingRequest? {
        self.latestPendingTelegramPairingRequest(now: now, stateDirURL: stateDirURL)
    }
}
#endif
