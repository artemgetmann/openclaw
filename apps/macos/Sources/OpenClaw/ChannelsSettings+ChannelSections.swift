import AppKit
import SwiftUI

extension ChannelsSettings {
    private var isConsumerSimpleTelegramPath: Bool {
        AppFlavor.current.isConsumer && !UserDefaults.standard.bool(forKey: showAdvancedSettingsKey)
    }

    func formSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 10) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    func channelHeaderActions(_ channel: ChannelItem) -> some View {
        HStack(spacing: 8) {
            if channel.id == "whatsapp" {
                Button("Logout") {
                    Task { await self.store.logoutWhatsApp() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.whatsappBusy)
            }

            if channel.id == "telegram", !self.isConsumerSimpleTelegramPath {
                Button("Logout") {
                    Task { await self.store.logoutTelegram() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.telegramBusy)
            }

            if !(channel.id == "telegram" && self.isConsumerSimpleTelegramPath) {
                Button {
                    Task { await self.store.refresh(probe: true) }
                } label: {
                    if self.store.isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Refresh")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.isRefreshing)
            }
        }
        .controlSize(.small)
    }

    var whatsAppSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Linking") {
                if let message = self.store.whatsappLoginMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let qr = self.store.whatsappLoginQrDataUrl, let image = self.qrImage(from: qr) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: 180, height: 180)
                        .cornerRadius(8)
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await self.store.startWhatsAppLogin(force: false) }
                    } label: {
                        if self.store.whatsappBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Show QR")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.store.whatsappBusy)

                    Button("Relink") {
                        Task { await self.store.startWhatsAppLogin(force: true) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.store.whatsappBusy)
                }
                .font(.caption)
            }

            self.configEditorSection(channelId: "whatsapp")
        }
    }

    var telegramSetupSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("One-time setup") {
                VStack(alignment: .leading, spacing: 14) {
                    Text("1. Open @BotFather.")
                        .font(.callout)

                    Button("Open BotFather") {
                        self.store.openTelegramBotFather()
                    }
                    .buttonStyle(.bordered)

                    Text("2. Send /newbot and follow the prompts.")
                        .font(.callout)

                    Text("3. Copy the bot token from BotFather.")
                        .font(.callout)

                    Text("4. Paste the token here and click Verify token.")
                        .font(.callout)

                    TextField("BotFather token", text: self.$store.telegramSetupToken)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .onChange(of: self.store.telegramSetupToken) { _, _ in
                            self.store.resetTelegramSetupProgressForEditedToken()
                        }

                    HStack(spacing: 10) {
                        Button("Verify token") {
                            Task { await self.store.verifyTelegramSetupToken() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.store.telegramBusy || self.store.telegramSetupPhase == .savingSetup)

                        if self.store.telegramSetupPhase == .verifyingToken {
                            ProgressView().controlSize(.small)
                        }

                        Button("Video walkthrough") {
                            self.store.openTelegramSetupVideo()
                        }
                        .buttonStyle(.bordered)
                        .disabled(AppFlavor.current.telegramSetupVideoURL == nil)
                    }

                    Text("5. Click Open your bot, send your bot one message, then click Capture first message.")
                        .font(.callout)

                    HStack(spacing: 10) {
                        if let username = self.store.telegramSetupBotUsername {
                            Button("Open your bot") {
                                self.store.openTelegramBot(username: username)
                            }
                            .buttonStyle(.bordered)
                        }

                        Button("Capture first message") {
                            Task { await self.store.captureTelegramFirstDirectMessage() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.store.telegramBusy || self.store.telegramSetupBotUsername == nil)

                        if self.store.telegramSetupWaitingForDM || self.store.telegramSetupPhase == .savingSetup {
                            ProgressView().controlSize(.small)
                        }

                        if let senderId = self.store.telegramSetupFirstSenderId {
                            Text("Captured: \(senderId)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if let status = self.store.telegramSetupStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text(
                    "Optional but recommended: in BotFather -> your bot -> Bot Settings, enable Threaded Mode for a better experience.")
                    .font(.callout)
                    .foregroundStyle(.primary)

                Text(
                    "Power users: for multiple tasks at once, add the bot to a Telegram group and use topics to keep each task separate.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    var consumerTelegramLiveSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.formSection("Connected bot") {
                VStack(alignment: .leading, spacing: 14) {
                    Text(
                        self.consumerTelegramBotUsername.map {
                            "Connected as @\($0)."
                        } ?? "Bot connected.")
                        .font(.callout)

                    if let username = self.consumerTelegramBotUsername {
                        Button("Open your bot") {
                            self.store.openTelegramBot(username: username)
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    Text(
                        "Optional but recommended: in BotFather -> your bot -> Bot Settings, enable Threaded Mode for a better experience.")
                        .font(.callout)
                        .foregroundStyle(.primary)

                    Text(
                        "Power users: for multiple tasks at once, add the bot to a Telegram group and use topics to keep each task separate.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    func genericChannelSection(_ channel: ChannelItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            self.configEditorSection(channelId: channel.id)
        }
    }

    @ViewBuilder
    private func configEditorSection(channelId: String) -> some View {
        self.formSection("Configuration") {
            ChannelConfigForm(store: self.store, channelId: channelId)
        }

        self.configStatusMessage

        HStack(spacing: 12) {
            Button {
                Task { await self.store.saveConfigDraft() }
            } label: {
                if self.store.isSavingConfig {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Save")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.store.isSavingConfig || !self.store.configDirty)

            Button("Reload") {
                Task { await self.store.reloadConfigDraft() }
            }
            .buttonStyle(.bordered)
            .disabled(self.store.isSavingConfig)

            Spacer()
        }
        .font(.caption)
    }

    @ViewBuilder
    var configStatusMessage: some View {
        if let status = self.store.configStatus {
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
