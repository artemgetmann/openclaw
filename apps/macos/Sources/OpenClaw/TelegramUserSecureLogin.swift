import Foundation
import Observation
import SwiftUI

struct TelegramUserLoginSnapshot: Decodable, Equatable {
    struct PendingLogin: Decodable, Equatable {
        let phone: String?
        let state: String
    }

    let authError: String?
    let pendingLogin: PendingLogin?
    let retryAfterSeconds: Int?
    let state: String

    enum CodingKeys: String, CodingKey {
        case authError = "auth_error"
        case pendingLogin = "pending_login"
        case retryAfterSeconds = "retry_after_seconds"
        case state
    }
}

@MainActor
@Observable
final class TelegramUserSecureLoginModel {
    var phone = ""
    private(set) var snapshot: TelegramUserLoginSnapshot?
    private(set) var status = "Check the connection, then start or resume local sign-in."
    private(set) var busy = false
    private(set) var cooldownUntil: Date?

    var needsSecret: Bool {
        guard self.snapshot?.pendingLogin != nil else { return false }
        return self.snapshot?.state == "awaiting_code" || self.snapshot?.state == "awaiting_password"
    }

    var secretLabel: String {
        self.snapshot?.state == "awaiting_password" ? "Telegram 2FA password" : "Telegram code"
    }

    var canSubmitSecret: Bool {
        guard self.needsSecret, !self.busy else { return false }
        return self.cooldownUntil.map { $0 <= Date() } ?? true
    }

    func refresh() async {
        await self.run(extraArgs: ["status", "--json"], secret: nil)
    }

    func start() async {
        let normalizedPhone = self.phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPhone.isEmpty else {
            self.status = "Enter the Telegram phone number in international format."
            return
        }
        await self.run(extraArgs: ["login", "--phone", normalizedPhone, "--json"], secret: nil)
    }

    func submit(secret: String) async {
        let normalizedSecret = secret.trimmingCharacters(in: .newlines)
        guard !normalizedSecret.isEmpty, let snapshot = self.snapshot else {
            self.status = "Enter the code or 2FA password in the secure field."
            return
        }
        let phone = snapshot.pendingLogin?.phone ?? self.phone
        let kind = snapshot.state == "awaiting_password" ? "password" : "code"
        await self.run(
            extraArgs: ["login", "--phone", phone, "--secret-stdin", kind, "--json"],
            secret: normalizedSecret)
    }

    private func run(extraArgs: [String], secret: String?) async {
        guard !self.busy else { return }
        self.busy = true
        defer { self.busy = false }

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        env["OPENCLAW_PROFILE"] = ConsumerRuntime.profile
        env["OPENCLAW_HOME"] = ConsumerRuntime.runtimeRootURL.path
        env["OPENCLAW_STATE_DIR"] = ConsumerRuntime.stateDirURL.path
        env["OPENCLAW_CONFIG_PATH"] = ConsumerRuntime.configURL.path
        env["OPENCLAW_GATEWAY_PORT"] = String(ConsumerRuntime.gatewayPort)
        env["OPENCLAW_GATEWAY_BIND"] = ConsumerRuntime.gatewayBind

        let command = CommandResolver.openclawCommand(
            subcommand: "telegram-user",
            extraArgs: extraArgs)
        // The only secret-bearing boundary is the anonymous local pipe. The
        // command array and environment contain routing metadata, never OTP/2FA.
        let input = secret.map { Data(($0 + "\n").utf8) }
        let result = await ShellExecutor.runDetailed(
            command: command,
            cwd: nil,
            env: env,
            timeout: 75,
            standardInput: input)
        guard result.success,
              let data = result.stdout.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(TelegramUserLoginSnapshot.self, from: data)
        else {
            self.status = "Telegram sign-in could not continue. Check local setup and try again once."
            return
        }
        self.snapshot = decoded
        self.applyStatus(decoded)
    }

    private func applyStatus(_ snapshot: TelegramUserLoginSnapshot) {
        switch snapshot.authError {
        case "code_invalid":
            self.status = "That code is invalid. Check the current Telegram code and submit once more."
        case "code_expired":
            self.status = "That code expired. Telegram sent a fresh code; use only the newest one."
        case "cooldown":
            let seconds = max(1, snapshot.retryAfterSeconds ?? 1)
            self.cooldownUntil = Date().addingTimeInterval(TimeInterval(seconds))
            self.status = "Telegram paused sign-in attempts. Try again in \(seconds) seconds."
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                self?.cooldownUntil = nil
            }
        default:
            self.cooldownUntil = nil
            switch snapshot.state {
            case "ready": self.status = "Telegram account connected on this Mac."
            case "awaiting_code": self.status = "Enter the code locally below. Never send it to Jarvis in Telegram."
            case "awaiting_password": self.status = "Enter your Telegram 2FA password locally below."
            case "missing_credentials": self.status = "Telegram API credentials must be added on this Mac first."
            case "needs_reauth": self.status = "The saved session expired. Start local sign-in again."
            default: self.status = "Telegram account is not connected yet."
            }
        }
    }
}

struct TelegramUserSecureLoginCard: View {
    @State private var model = TelegramUserSecureLoginModel()
    @State private var secret = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect your Telegram account")
                .font(.headline)
            Text(
                "Jarvis can read a fresh OTP screenshot sent in chat. Never paste or forward the code. Telegram 2FA passwords must be entered securely here.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if self.model.snapshot?.pendingLogin == nil, self.model.snapshot?.state != "ready" {
                TextField("+1 555 123 4567", text: self.$model.phone)
                    .textContentType(.telephoneNumber)
                Button("Start local sign-in") { Task { await self.model.start() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.model.busy)
            }

            if self.model.needsSecret {
                SecureField(self.model.secretLabel, text: self.$secret)
                    .textContentType(.oneTimeCode)
                    .onSubmit { self.submitSecret() }
                Button("Submit securely") { self.submitSecret() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!self.model.canSubmitSecret || self.secret.isEmpty)
            }

            HStack {
                Text(self.model.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Check status") { Task { await self.model.refresh() } }
                    .buttonStyle(.bordered)
                    .disabled(self.model.busy)
            }
        }
        .task { await self.model.refresh() }
    }

    private func submitSecret() {
        let submitted = self.secret
        self.secret = ""
        Task { await self.model.submit(secret: submitted) }
    }
}
