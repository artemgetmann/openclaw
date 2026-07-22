import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct TelegramSetupVerifierTests {
    @Test func `first task ignores telegram activation and non-text updates`() {
        #expect(!TelegramSetupVerifier.isFirstTaskMessage(text: "/start", caption: nil))
        #expect(!TelegramSetupVerifier.isFirstTaskMessage(text: "/start welcome", caption: nil))
        #expect(!TelegramSetupVerifier.isFirstTaskMessage(text: "/start@jarvis_test_bot", caption: nil))
        #expect(!TelegramSetupVerifier.isFirstTaskMessage(text: "   ", caption: nil))
        #expect(TelegramSetupVerifier.isFirstTaskMessage(text: "Wake up, my friend!", caption: nil))
        #expect(TelegramSetupVerifier.isFirstTaskMessage(text: nil, caption: "Please read this"))
    }

    @Test func `first task recovers from early verify start command and transient polling conflict`() async throws {
        var batches: [Result<[TelegramUpdate], Error>] = [
            .failure(TelegramSetupVerifierError.conflict),
            .success([self.update(id: 1, text: "/start")]),
            .success([self.update(id: 2, text: "Wake up, my friend!")]),
        ]

        let message = try await TelegramSetupVerifier.waitForFirstDirectMessage(
            token: "123456:test",
            timeoutSeconds: 45,
            fetchUpdates: { _, _ in
                try batches.removeFirst().get()
            },
            sleep: { _ in })

        #expect(message?.updateId == 2)
        #expect(message?.text == "Wake up, my friend!")
        #expect(batches.isEmpty)
    }

    @Test func `normalize token strips quotes whitespace and invisible marks`() {
        let zeroWidthSpace = "\u{200B}"
        let raw = "  \"123456:ABC\(zeroWidthSpace)def\" \n"

        let normalized = TelegramSetupVerifier.normalizeToken(raw)

        #expect(normalized == "123456:ABCdef")
    }

    @Test func `normalize token preserves ordinary telegram token characters`() {
        let raw = "123456:AAAbbb_CCC-ddd"

        let normalized = TelegramSetupVerifier.normalizeToken(raw)

        #expect(normalized == raw)
    }

    @Test func `request url preserves telegram colon separator`() throws {
        let url = try TelegramSetupVerifier.requestURL(
            token: "123456:ABCdef",
            method: "getMe",
            queryItems: [])

        #expect(url.absoluteString == "https://api.telegram.org/bot123456:ABCdef/getMe")
    }

    private func update(id: Int, text: String) -> TelegramUpdate {
        TelegramUpdate(
            updateId: id,
            message: TelegramMessage(
                messageId: id,
                from: TelegramUser(
                    id: 42,
                    isBot: false,
                    firstName: "Owner",
                    username: "owner"),
                chat: TelegramChat(id: 42, type: "private", username: "owner"),
                text: text,
                caption: nil,
                date: 1_721_600_000,
                messageThreadId: nil))
    }
}
