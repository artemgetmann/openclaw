import AppKit
import SwiftUI

extension ChannelsSettings {
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

            if channel.id == "telegram" {
                Button("Logout") {
                    Task { await self.store.logoutTelegram() }
                }
                .buttonStyle(.bordered)
                .disabled(self.store.telegramBusy)
            }

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
                Text("1. Open @BotFather, run /newbot, and copy the token.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("2. Paste the token here and verify it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("3. Send one private message so OpenClaw can lock your DM allow list.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("4. Keep groups enabled for longer or parallel work with topics.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
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

                HStack(spacing: 10) {
                    Button("Open BotFather") {
                        self.store.openTelegramBotFather()
                    }
                    .buttonStyle(.bordered)

                    Button("Verify token") {
                        Task { await self.store.verifyTelegramSetupToken() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.store.telegramBusy)

                    if let username = self.store.telegramSetupBotUsername {
                        Button("Open bot") {
                            self.store.openTelegramBot(username: username)
                        }
                        .buttonStyle(.bordered)
                    }
                }

                HStack(spacing: 10) {
                    Button("Capture first DM") {
                        Task { await self.store.captureTelegramFirstDirectMessage() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.store.telegramBusy || self.store.telegramSetupBotUsername == nil)

                    if self.store.telegramSetupWaitingForDM {
                        ProgressView().controlSize(.small)
                    }

                    if let senderId = self.store.telegramSetupFirstSenderId {
                        Text("First sender: \(senderId)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let status = self.store.telegramSetupStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("DMs start simple. Groups and topics stay available for longer or parallel work.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
