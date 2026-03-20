import AppKit
import Foundation

extension ChannelsStore {
    func openTelegramBotFather() {
        self.openTelegramURL("https://t.me/BotFather")
    }

    func openTelegramBot(username: String) {
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        self.openTelegramURL("https://t.me/\(username)")
    }

    func verifyTelegramSetupToken() async {
        let token = self.telegramSetupToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            self.telegramSetupStatus = "Paste your BotFather token first."
            return
        }

        guard !self.telegramBusy else { return }
        self.telegramBusy = true
        defer { self.telegramBusy = false }

        self.telegramSetupStatus = "Checking the token with Telegram..."
        do {
            let bot = try await TelegramSetupVerifier.verifyBot(token: token)
            self.telegramSetupBotId = bot.id
            self.telegramSetupBotUsername = bot.username
            self.telegramSetupStatus = bot.username.map {
                "Token verified for @\($0). Now send one private message to the bot."
            } ?? "Token verified. Now send one private message to the bot."
            await self.applyTelegramSetupBootstrap(
                token: token,
                dmPolicy: "pairing",
                allowFrom: nil)
            if let username = bot.username {
                self.openTelegramBot(username: username)
            }
        } catch {
            self.telegramSetupStatus = error.localizedDescription
        }
    }

    func captureTelegramFirstDirectMessage() async {
        let token = self.telegramSetupToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            self.telegramSetupStatus = "Paste your BotFather token first."
            return
        }

        guard !self.telegramBusy else { return }
        self.telegramBusy = true
        self.telegramSetupWaitingForDM = true
        defer {
            self.telegramBusy = false
            self.telegramSetupWaitingForDM = false
        }

        self.telegramSetupStatus = "Waiting for the first private message..."
        do {
            guard let dm = try await TelegramSetupVerifier.waitForFirstDirectMessage(token: token) else {
                self.telegramSetupStatus = TelegramSetupVerifierError.noDirectMessage.localizedDescription
                return
            }

            self.telegramSetupFirstSenderId = String(dm.senderId)
            await self.applyTelegramSetupBootstrap(
                token: token,
                dmPolicy: "allowlist",
                allowFrom: [String(dm.senderId)])
            self.telegramSetupStatus = dm.senderUsername.map {
                "Locked to @\($0). Groups stay enabled; add the bot to a group when you want threaded work."
            } ?? "Locked to Telegram user ID \(dm.senderId). Groups stay enabled; add the bot to a group when you want threaded work."
        } catch {
            self.telegramSetupStatus = error.localizedDescription
        }
    }

    private func applyTelegramSetupBootstrap(
        token: String,
        dmPolicy: String,
        allowFrom: [String]?
    ) async {
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("enabled")], value: true)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("botToken")], value: token)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("dmPolicy")], value: dmPolicy)
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("groupPolicy")], value: "open")
        self.updateConfigValue(path: [.key("channels"), .key("telegram"), .key("allowFrom")], value: allowFrom)
        await self.saveConfigDraft()
        await self.refresh(probe: true)
    }

    private func openTelegramURL(_ raw: String) {
        guard let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }
}
