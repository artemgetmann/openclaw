import Foundation
import Testing
@testable import OpenClaw

@Suite struct TelegramUserSecureLoginTests {
    @Test func `login snapshot preserves invalid expired and cooldown fields`() throws {
        let payload = Data("""
        {"state":"awaiting_code","pending_login":{"phone":"+15551234567","state":"awaiting_code"},"auth_error":"cooldown","retry_after_seconds":42}
        """.utf8)

        let snapshot = try JSONDecoder().decode(TelegramUserLoginSnapshot.self, from: payload)

        #expect(snapshot.state == "awaiting_code")
        #expect(snapshot.authError == "cooldown")
        #expect(snapshot.retryAfterSeconds == 42)
        #expect(snapshot.pendingLogin?.phone == "+15551234567")
    }

    @Test func `shell executor writes secret only to local stdin`() async {
        let secret = "otp-must-not-appear-in-argv"
        let result = await ShellExecutor.runDetailed(
            command: ["/bin/sh", "-c", "read value; printf %s ${#value}"],
            cwd: nil,
            env: nil,
            timeout: 5,
            standardInput: Data((secret + "\n").utf8))

        #expect(result.success)
        #expect(result.stdout == String(secret.count))
        #expect(result.stderr.isEmpty)
    }
}
