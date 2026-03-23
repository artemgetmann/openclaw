import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct TelegramSetupVerifierTests {
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
}
