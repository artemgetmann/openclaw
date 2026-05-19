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

    private var statusText: String? {
        if let conflict = self.store.consumerTelegramConflictMessage(self.store.telegramSetupStatus) {
            return conflict
        }
        if let accessGate = self.store.consumerTelegramAccessGateMessage(self.store.telegramSetupStatus) {
            return accessGate
        }
        return self.store.telegramSetupStatus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.presentation == .onboarding {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connect Telegram")
                        .font(.headline)
                    Text("Create your Jarvis bot, approve it in Telegram, then send one DM task to confirm it works.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
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
                    "Connected as @\($0). \(AppFlavor.current.appName) answered a real Telegram task."
                } ?? "Telegram is connected and \(AppFlavor.current.appName) answered a real task.")

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
            self.callout(
                title: self.store.consumerTelegramLooksLive() ? "One task left" : "Create your Telegram bot",
                body: self.store.consumerTelegramLooksLive()
                    ? "The bot is connected. Send it one normal DM task so \(AppFlavor.current.appName) can prove the loop works."
                    : "\(AppFlavor.current.appName) will open Telegram so you can approve a new bot. Start with a DM; groups and topics can come later.")

            HStack(spacing: 10) {
                Button("Create Telegram bot") {
                    Task { await self.store.startManagedTelegramSetup() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.store.telegramBusy || self.store.telegramSetupPhase != .idle)

                if self.store.telegramManagedApprovalURL != nil {
                    Button("Open approval") {
                        self.store.openTelegramManagedApproval()
                    }
                    .buttonStyle(.bordered)
                }

                if self.managedSetupIsBusy {
                    ProgressView().controlSize(.small)
                }
            }

            if let suggestedUsername = self.store.telegramManagedSuggestedBotUsername {
                Text("Telegram will ask you to approve @\(suggestedUsername).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button("Check status") {
                    Task { await self.store.checkManagedTelegramSetupStatus() }
                }
                .buttonStyle(.bordered)
                .disabled(
                    self.store.telegramBusy
                        || self.store.telegramManagedSetupId == nil
                        || self.store.telegramSetupPhase != .idle)

                if let username = self.store.consumerTelegramBotUsername() {
                    Button("Open your bot") {
                        self.store.openTelegramBot(username: username)
                    }
                    .buttonStyle(.bordered)
                }
            }

            Text("Send one real task as a DM to your bot, then verify the first task.")
                .font(.callout)

            HStack(spacing: 10) {
                Button("Verify first task") {
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

                if let senderId = self.store.telegramSetupFirstSenderId {
                    Text("Verified sender: \(senderId)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let runtimeOwnershipIssue {
                Text(runtimeOwnershipIssue)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let statusText {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("No extra Mac permissions are needed just to verify Telegram.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            DisclosureGroup("Advanced: use BotFather instead", isExpanded: self.$manualSetupExpanded) {
                self.manualBotFatherSetup
            }
            .font(.callout)
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
                    Button("Written guide") {
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

            Text("Start with a DM. Group chats and topics are advanced setup after the first task works.")
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
}
