import SwiftUI

struct ConsumerTelegramSetupCardContent: View {
    enum Presentation {
        case onboarding
        case settings
    }

    @Bindable var store: ChannelsStore
    let presentation: Presentation
    @FocusState private var tokenFieldFocused: Bool

    private var normalizedToken: String {
        TelegramSetupVerifier.normalizeToken(self.store.telegramSetupToken)
    }

    private var runtimeOwnershipIssue: String? {
        self.store.telegramRuntimeOwnershipIssue()
    }

    private var isTokenEditingLocked: Bool {
        self.store.telegramBusy || self.store.telegramSetupPhase != .idle
    }

    private var statusText: String? {
        if let conflict = self.store.consumerTelegramConflictMessage(self.store.telegramSetupStatus) {
            return conflict
        }
        return self.store.telegramSetupStatus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if self.presentation == .onboarding {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connect Telegram")
                        .font(.headline)
                    Text("Setup only counts as done after OpenClaw finishes one real Telegram task from this Mac.")
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
                    "Connected as @\($0). OpenClaw already finished a Telegram task on this Mac."
                } ?? "Telegram is connected and OpenClaw already finished a Telegram task on this Mac.")

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
                title: self.store.consumerTelegramLooksLive() ? "One task left" : "Use your own Telegram bot",
                body: self.store.consumerTelegramLooksLive()
                    ? "The bot is connected, but onboarding is not complete until OpenClaw answers one Telegram task end-to-end on this Mac."
                    : "Create a bot in BotFather, verify the token here, then send the first task you want OpenClaw to handle.")

            Text("1. Open @BotFather, send /newbot, choose a name + username, then copy the full token BotFather gives you.")
                .font(.callout)

            HStack(spacing: 10) {
                Button("Open BotFather") {
                    self.store.openTelegramBotFather()
                }
                .buttonStyle(.bordered)

                if let _ = AppFlavor.current.telegramSetupGuideURL {
                    Button("Written guide") {
                        self.store.openTelegramSetupGuide()
                    }
                    .buttonStyle(.bordered)
                }

                if let _ = AppFlavor.current.telegramSetupVideoURL {
                    Button("Video walkthrough") {
                        self.store.openTelegramSetupVideo()
                    }
                    .buttonStyle(.bordered)
                }
            }

            Text("2. Paste that exact token here and verify it. Do not trim it, shorten it, or copy the bot username instead.")
                .font(.callout)

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
                .buttonStyle(.borderedProminent)
                .disabled(self.store.telegramBusy || self.store.telegramSetupPhase == .savingSetup)

                if self.store.telegramSetupPhase == .verifyingToken {
                    ProgressView().controlSize(.small)
                }

                if self.presentation == .settings, AppFlavor.current.telegramSetupVideoURL != nil {
                    Button("Video walkthrough") {
                        self.store.openTelegramSetupVideo()
                    }
                    .buttonStyle(.bordered)
                }
            }

            Text("3. Open the bot, press Start if Telegram shows it, send one real task in DM, then click Verify first task here.")
                .font(.callout)

            HStack(spacing: 10) {
                if let username = self.store.consumerTelegramBotUsername() {
                    Button("Open your bot") {
                        self.store.openTelegramBot(username: username)
                    }
                    .buttonStyle(.bordered)
                }

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

            Text("No extra macOS permissions are required just to verify Telegram. Optional system permissions stay later.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Text("Telegram groups are stricter than DMs: if BotFather Group Privacy stays on, the bot will usually ignore normal group messages unless someone tags it or replies to it. If you want normal group chat behavior, disable Group Privacy in BotFather, then remove and re-add the bot so Telegram actually applies the change. Enable topics/threaded mode for the cleanest multi-task setup.")
                .font(.callout)
                .foregroundStyle(.primary)

            Text("Power users: for multiple tasks at once, add the bot to a Telegram group and use topics.")
                .font(.callout)
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
