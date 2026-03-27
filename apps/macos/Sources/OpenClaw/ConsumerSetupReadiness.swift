import Foundation
import Observation
import SwiftUI

private let consumerBrowserProfileName = "user"

struct ConsumerShellCommandResult {
    let stdout: String
    let stderr: String
    let exitCode: Int?
    let success: Bool
}

private enum ConsumerSetupCommandRunner {
    private static func consumerCommandEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        // Shell-outs used during onboarding must target the exact consumer lane
        // currently shown in the app. Relying on ambient machine state lets a
        // different worktree/default install answer the question instead.
        env["OPENCLAW_PROFILE"] = ConsumerRuntime.profile
        env["OPENCLAW_HOME"] = ConsumerRuntime.runtimeRootURL.path
        env["OPENCLAW_STATE_DIR"] = ConsumerRuntime.stateDirURL.path
        env["OPENCLAW_CONFIG_PATH"] = ConsumerRuntime.configURL.path
        env["OPENCLAW_GATEWAY_PORT"] = String(ConsumerRuntime.gatewayPort)
        env["OPENCLAW_GATEWAY_BIND"] = ConsumerRuntime.gatewayBind
        env["OPENCLAW_LOG_DIR"] = ConsumerRuntime.logsDirURL.path
        env["OPENCLAW_LAUNCHD_LABEL"] = ConsumerRuntime.gatewayLaunchdLabel
        if let id = ConsumerInstance.current.id {
            env[ConsumerInstance.envKey] = id
        } else {
            env.removeValue(forKey: ConsumerInstance.envKey)
        }
        if let projectRoot = CommandResolver.projectRootEnvironmentHint() {
            env["OPENCLAW_FORK_ROOT"] = projectRoot
        }
        return env
    }

    static func runOpenClaw(
        subcommand: String,
        extraArgs: [String],
        timeout: Double
    ) async -> ConsumerShellCommandResult {
        let command = CommandResolver.openclawCommand(subcommand: subcommand, extraArgs: extraArgs)
        let result = await ShellExecutor.runDetailed(
            command: command,
            cwd: nil,
            env: self.consumerCommandEnvironment(),
            timeout: timeout)
        return ConsumerShellCommandResult(
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            success: result.success)
    }

    static func bestEffortMessage(for result: ConsumerShellCommandResult) -> String {
        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stdout.isEmpty {
            return stdout
        }
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty {
            return stderr
        }
        if let exitCode = result.exitCode {
            return "exit \(exitCode)"
        }
        return "command failed"
    }
}

private struct ConsumerBrowserStatusPayload: Decodable {
    let enabled: Bool
    let running: Bool
    let chosenBrowser: String?
    let detectedBrowser: String?
    let detectedExecutablePath: String?
    let detectError: String?
}

@MainActor
@Observable
final class ConsumerModelSetupModel {
    enum Phase: Equatable {
        case idle
        case checking
        case ready(String)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var statusLine: String?

    var isComplete: Bool {
        if case .ready = self.phase {
            return true
        }
        return false
    }

    func refreshIfNeeded() async {
        guard self.phase == .idle else { return }
        await self.refresh()
    }

    func refresh() async {
        self.phase = .checking
        self.statusLine = "Checking OpenClaw's AI access…"

        let result = await ConsumerSetupCommandRunner.runOpenClaw(
            subcommand: "models",
            extraArgs: ["status", "--json", "--check"],
            timeout: 20)

        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = stdout.data(using: .utf8).flatMap {
            try? JSONDecoder().decode(ConsumerModelsStatusPayload.self, from: $0)
        }

        if result.success, let payload {
            let model = payload.defaultModel?.trimmingCharacters(in: .whitespacesAndNewlines)
            let display = (model?.isEmpty == false ? model : payload.resolvedDefault) ?? "the default model"
            self.phase = .ready(display)
            self.statusLine = "AI ready on \(display)."
            return
        }

        let detail = payload?.consumerFailureMessage ?? ConsumerSetupCommandRunner.bestEffortMessage(for: result)
        self.phase = .failed(detail)
        self.statusLine = detail
    }
}

private struct ConsumerModelsStatusPayload: Decodable {
    struct Auth: Decodable {
        struct OAuth: Decodable {
            struct Profile: Decodable {
                let provider: String
                let status: String
                let remainingMs: Double?
            }

            let profiles: [Profile]?
        }

        let missingProvidersInUse: [String]?
        let oauth: OAuth?
    }

    let defaultModel: String?
    let resolvedDefault: String?
    let auth: Auth

    var consumerFailureMessage: String {
        if let missingProvider = self.auth.missingProvidersInUse?.first {
            return "OpenClaw is not ready for a first task yet. Missing AI access for \(missingProvider). Reopen the app or switch to your own model in Advanced."
        }
        if let expired = self.auth.oauth?.profiles?.first(where: { $0.status == "expired" || $0.status == "missing" }) {
            return "OpenClaw's AI credential for \(expired.provider) is unavailable. Reopen the app or switch to your own model in Advanced."
        }
        if let expiring = self.auth.oauth?.profiles?.first(where: { $0.status == "expiring" }) {
            let remaining = expiring.remainingMs.map {
                formatRemainingShort(Int($0), underMinuteLabel: "under a minute")
            } ?? "soon"
            return "OpenClaw's AI credential for \(expiring.provider) expires \(remaining). Refresh it before relying on this build."
        }
        return "OpenClaw is not ready for a first task yet. Reopen the app or switch to your own model in Advanced."
    }
}

private func formatRemainingShort(_ remainingMs: Int, underMinuteLabel: String) -> String {
    if remainingMs <= 0 {
        return "now"
    }
    let roundedMinutes = Int((Double(remainingMs) / 60_000).rounded())
    if roundedMinutes < 1 {
        return underMinuteLabel
    }
    if roundedMinutes < 60 {
        return "in \(roundedMinutes)m"
    }
    let roundedHours = Int((Double(roundedMinutes) / 60).rounded())
    if roundedHours < 48 {
        return "in \(roundedHours)h"
    }
    let roundedDays = Int((Double(roundedHours) / 24).rounded())
    return "in \(roundedDays)d"
}

extension BrowserSetupModel {
    static func persistedConsumerBrowserSourceProfileName() -> String? {
        let root = OpenClawConfigFile.loadDict()
        let browser = root["browser"] as? [String: Any]
        let profiles = browser?["profiles"] as? [String: Any]
        let user = profiles?[consumerBrowserProfileName] as? [String: Any]
        return (user?["sourceProfileName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func persistConsumerBrowserSelection(_ profile: ChromeProfileCandidate) {
        var root = OpenClawConfigFile.loadDict()
        var browser = root["browser"] as? [String: Any] ?? [:]
        var profiles = browser["profiles"] as? [String: Any] ?? [:]
        var user = profiles[consumerBrowserProfileName] as? [String: Any] ?? [:]

        // Consumer browser onboarding must write the real runtime config, not only
        // app-local defaults, otherwise the product claims a browser is connected
        // while the gateway still has no idea which Chrome profile to clone.
        let managedUserCdpPort = OpenClawConfigFile.managedBrowserUserCdpPort()
        user["cdpPort"] = managedUserCdpPort
        user["driver"] = "openclaw"
        user["cloneFromUserProfile"] = true
        user["sourceProfileName"] = profile.directoryName
        user["color"] = (user["color"] as? String) ?? "#00AA00"
        profiles[consumerBrowserProfileName] = user
        browser["enabled"] = true
        browser["defaultProfile"] = consumerBrowserProfileName
        browser["profiles"] = profiles
        root["browser"] = browser
        OpenClawConfigFile.saveDict(root)
    }

    static func clearConsumerBrowserSelectionFromConfig() {
        var root = OpenClawConfigFile.loadDict()
        guard var browser = root["browser"] as? [String: Any] else { return }

        if var profiles = browser["profiles"] as? [String: Any] {
            profiles.removeValue(forKey: consumerBrowserProfileName)
            if profiles.isEmpty {
                browser.removeValue(forKey: "profiles")
            } else {
                browser["profiles"] = profiles
            }
        }

        if (browser["defaultProfile"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == consumerBrowserProfileName {
            browser.removeValue(forKey: "defaultProfile")
        }

        if browser.isEmpty {
            root.removeValue(forKey: "browser")
        } else {
            root["browser"] = browser
        }
        OpenClawConfigFile.saveDict(root)
    }

    static func verifyConsumerBrowserSelection(
        expectedProfile: ChromeProfileCandidate? = nil,
        runBrowserStatus: ((String, [String], TimeInterval) async -> ConsumerShellCommandResult)? = nil) async -> String?
    {
        if let expectedProfile {
            let persistedProfile = self.persistedConsumerBrowserSourceProfileName() ?? ""
            if persistedProfile != expectedProfile.directoryName {
                return "OpenClaw saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."
            }
        }

        // Browser readiness should follow the direct browser-status command path.
        // First-run onboarding can hit gateway pairing races that are unrelated to
        // whether Chrome itself is ready, so we avoid treating control-channel
        // readiness as a prerequisite here.
        let result = if let runBrowserStatus {
            await runBrowserStatus(
                "browser",
                ["--json", "--browser-profile", consumerBrowserProfileName, "status"],
                20)
        } else {
            await ConsumerSetupCommandRunner.runOpenClaw(
                subcommand: "browser",
                extraArgs: ["--json", "--browser-profile", consumerBrowserProfileName, "status"],
                timeout: 20)
        }
        guard result.success else {
            return "OpenClaw saved the Chrome profile, but browser readiness failed. \(ConsumerSetupCommandRunner.bestEffortMessage(for: result))"
        }
        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = stdout.data(using: .utf8),
              let payload = try? JSONDecoder().decode(ConsumerBrowserStatusPayload.self, from: data)
        else {
            return "OpenClaw saved the Chrome profile, but browser readiness returned unreadable output."
        }
        if payload.enabled == false {
            return "Browser control is disabled in config. Re-enable it and try again."
        }
        if let detectError = payload.detectError?.trimmingCharacters(in: .whitespacesAndNewlines),
           !detectError.isEmpty
        {
            return "OpenClaw saved the Chrome profile, but could not prepare Chrome on this Mac: \(detectError)"
        }
        if payload.chosenBrowser == nil && payload.detectedBrowser == nil && payload.detectedExecutablePath == nil {
            return "OpenClaw saved the Chrome profile, but Chrome still does not look ready on this Mac."
        }
        return nil
    }
}

struct ConsumerModelSetupCardContent: View {
    @Bindable var model: ConsumerModelSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("AI access")
                    .font(.headline)
                Text("OpenClaw needs a working model before the first real task can succeed.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            switch self.model.phase {
            case .idle, .checking:
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text(self.model.statusLine ?? "Checking OpenClaw's AI access…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            case let .ready(modelRef):
                self.callout(
                    title: "AI is ready",
                    body: "OpenClaw is ready to run the first delegated task on \(modelRef).")
            case let .failed(message):
                VStack(alignment: .leading, spacing: 12) {
                    self.callout(title: "AI setup still needs attention", body: message)
                    Button("Check Again") {
                        Task { await self.model.refresh() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .task {
            await self.model.refreshIfNeeded()
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
