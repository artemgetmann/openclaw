import SwiftUI

struct ConsumerTelegramSetupCardContent: View {
    enum Presentation {
        case onboarding
        case settings
    }

    @Bindable var store: ChannelsStore
    let presentation: Presentation
    @FocusState private var tokenFieldFocused: Bool
    @State private var manualSetupExpanded = false

    private var normalizedToken: String {
        TelegramSetupVerifier.normalizeToken(self.store.telegramSetupToken)
    }

    private var runtimeOwnershipIssue: String? {
        self.store.telegramRuntimeOwnershipIssue()
    }

    private var isTokenEditingLocked: Bool {
        self.store.telegramBusy || self.store.telegramSetupPhase != .idle
    }

    private var managedSetupIsBusy: Bool {
        switch self.store.telegramSetupPhase {
        case .startingManagedBot, .checkingManagedApproval, .installingManagedBot:
            true
        default:
            false
        }
    }

    private var readyForFirstTaskVerification: Bool {
        // Show the first-DM step only after setup has real bot evidence. The
        // default screen should stay focused on creating/approving the managed
        // bot instead of asking for a message the user cannot send yet.
        !self.normalizedToken.isEmpty
            || self.store.consumerTelegramLooksLive()
            || self.store.consumerTelegramBotUsername() != nil
    }

    private var managedSetupCanBeChecked: Bool {
        self.store.telegramManagedSetupId != nil || self.store.telegramManagedApprovalURL != nil
    }

    private var awaitingManagedApproval: Bool {
        !self.readyForFirstTaskVerification
            && (self.managedSetupCanBeChecked || self.store.telegramManagedSuggestedBotUsername != nil)
    }

    private var pendingApprovalInstruction: String? {
        guard self.awaitingManagedApproval else { return nil }
        return self.store.telegramManagedSuggestedBotUsername.map {
            "In Telegram, approve @\($0), click Create, then click Check status here."
        } ?? "In Telegram, approve the bot, click Create, then click Check status here."
    }

    private var showsInitialSetupAction: Bool {
        (!self.awaitingManagedApproval && !self.readyForFirstTaskVerification)
            || self.managedSetupIsBusy
    }

    private var statusText: String? {
        if let conflict = self.store.consumerTelegramConflictMessage(self.store.telegramSetupStatus) {
            return conflict
        }
        if let accessGate = self.store.consumerTelegramAccessGateMessage(self.store.telegramSetupStatus) {
            return accessGate
        }
        return self.store.telegramSetupStatus
    }

    private var visibleStatusText: String? {
        guard let statusText else { return nil }
        if self.awaitingManagedApproval, self.isManagedApprovalInstruction(statusText) {
            return nil
        }
        if self.readyForFirstTaskVerification, self.isFirstTaskInstruction(statusText) {
            return nil
        }
        return statusText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.presentation == .onboarding {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Jarvis works through a private Telegram bot on this Mac.")
                        .font(.subheadline.weight(.semibold))
                }
            }

            if self.store.consumerTelegramReadyForFirstTask() {
                self.verifiedState
            } else {
                self.setupState
            }
        }
    }

    private var verifiedState: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "Telegram verified",
                body: self.store.consumerTelegramBotUsername().map {
                    "Connected as @\($0). \(AppFlavor.current.appName) answered your first Telegram DM."
                } ?? "Telegram is connected and \(AppFlavor.current.appName) answered your first Telegram DM.")

            if let username = self.store.consumerTelegramBotUsername() {
                Button("Open your bot") {
                    self.store.openTelegramBot(username: username)
                }
                .buttonStyle(.borderedProminent)
            }

            if let statusText {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var setupState: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.presentation == .settings
                || (self.store.consumerTelegramLooksLive() && !self.readyForFirstTaskVerification)
            {
                self.callout(
                    title: self.store.consumerTelegramLooksLive() ? "One task left" : "Private Telegram bot",
                    body: self.store.consumerTelegramLooksLive()
                        ? "The bot is ready for the final Telegram check."
                        : "\(AppFlavor.current.appName) will open Telegram so you can approve the bot.")
            }

            if self.showsInitialSetupAction {
                HStack(spacing: 10) {
                    Button("Set Up in Telegram") {
                        Task { await self.store.startManagedTelegramSetup() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.store.telegramBusy || self.store.telegramSetupPhase != .idle)

                    if self.managedSetupIsBusy {
                        ProgressView().controlSize(.small)
                    }
                }
            }

            if let pendingApprovalInstruction {
                Text(pendingApprovalInstruction)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if self.awaitingManagedApproval {
                HStack(spacing: 10) {
                    if self.store.telegramManagedApprovalURL != nil {
                        Button("Open Telegram") {
                            self.store.openTelegramManagedApproval()
                        }
                        .buttonStyle(.bordered)
                    }

                    if self.managedSetupCanBeChecked {
                        Button("Check status") {
                            Task { await self.store.checkManagedTelegramSetupStatus() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(
                            self.store.telegramBusy
                                || self.store.telegramManagedSetupId == nil
                                || self.store.telegramSetupPhase != .idle)
                    }
                }
            }

            if self.readyForFirstTaskVerification {
                Text("Bot connected. Send \"Wake up my friend\" to Jarvis in Telegram, then click Verify Telegram.")
                    .font(.callout)

                HStack(spacing: 10) {
                    if let username = self.store.consumerTelegramBotUsername() {
                        Button("Open your bot") {
                            self.store.openTelegramBot(username: username)
                        }
                        .buttonStyle(.bordered)
                    }

                    Button("Verify Telegram") {
                        self.tokenFieldFocused = false
                        Task { await self.store.verifyConsumerTelegramFirstTask() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        self.store.telegramBusy
                            || self.normalizedToken.isEmpty
                            || self.runtimeOwnershipIssue != nil)

                    if self.store.telegramSetupWaitingForDM
                        || self.store.telegramSetupPhase == .savingSetup
                        || self.store.telegramSetupPhase == .startingFirstReply
                    {
                        ProgressView().controlSize(.small)
                    }

                }
            }

            if let runtimeOwnershipIssue {
                Text(runtimeOwnershipIssue)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let statusText = self.visibleStatusText {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            DisclosureGroup("Advanced: use an existing bot with BotFather", isExpanded: self.$manualSetupExpanded) {
                self.manualBotFatherSetup
            }
            .font(.callout)
            .padding(.top, self.presentation == .onboarding ? 28 : 8)
        }
    }

    private var manualBotFatherSetup: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Use this if Jarvis bot creation is unavailable or you already have a bot token.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Text("Open @BotFather, send /newbot, choose a name and username, then copy the full token BotFather gives you.")
                .font(.callout)

            HStack(spacing: 10) {
                Button("Open BotFather") {
                    self.store.openTelegramBotFather()
                }
                .buttonStyle(.bordered)

                if AppFlavor.current.telegramSetupGuideURL != nil {
                    Button("BotFather guide") {
                        self.store.openTelegramSetupGuide()
                    }
                    .buttonStyle(.bordered)
                }

                if AppFlavor.current.telegramSetupVideoURL != nil {
                    Button("Video walkthrough") {
                        self.store.openTelegramSetupVideo()
                    }
                    .buttonStyle(.bordered)
                }
            }

            TextField("BotFather token", text: self.$store.telegramSetupToken)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .focused(self.$tokenFieldFocused)
                .disabled(self.isTokenEditingLocked)
                .onChange(of: self.store.telegramSetupToken) { oldValue, newValue in
                    guard !self.isTokenEditingLocked else { return }
                    guard TelegramSetupVerifier.normalizeToken(oldValue) != TelegramSetupVerifier.normalizeToken(newValue) else { return }
                    self.store.resetTelegramSetupProgressForEditedToken()
                }

            HStack(spacing: 10) {
                Button("Verify token") {
                    self.tokenFieldFocused = false
                    Task { await self.store.verifyTelegramSetupToken() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.telegramBusy || self.store.telegramSetupPhase == .savingSetup)

                if self.store.telegramSetupPhase == .verifyingToken {
                    ProgressView().controlSize(.small)
                }
            }

            Text("Start with a direct message. Group setup comes later.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func callout(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func isManagedApprovalInstruction(_ text: String) -> Bool {
        let normalized = text.lowercased()
        return normalized.contains("approve")
            && normalized.contains("click create")
            && (normalized.contains("check status") || normalized.contains("check again"))
    }

    private func isFirstTaskInstruction(_ text: String) -> Bool {
        let normalized = text.lowercased()
        return normalized.contains("click verify first task")
            || normalized.contains("click verify telegram")
            || normalized.contains("send \"wake up my friend")
            || normalized.contains("send one message to jarvis")
            || normalized.contains("first task to approve sender access")
    }
}
