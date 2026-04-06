import AppKit
import Foundation
import Observation
import OpenClawKit
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

    static func isTransientBrowserStatusFailure(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("gateway closed") ||
            normalized.contains("abnormal closure") ||
            normalized.contains("no close reason") ||
            normalized.contains("could not connect to the server") ||
            normalized.contains("connect to gateway") ||
            normalized.contains("gateway connection dropped") ||
            normalized.contains("gateway not connected") ||
            normalized.contains("timed out") ||
            normalized.contains("timeout") ||
            normalized.contains("retry")
    }

    static func isDiskFullFailure(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("enospc") ||
            normalized.contains("no space left on device") ||
            normalized.contains("disk is full")
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

struct ConsumerSelectableModel: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
}

struct ConsumerAuthProviderChoice: Identifiable, Equatable {
    let id: String
    let label: String
}

enum ConsumerAIAccessFailureKind: Equatable {
    case gatewayUnreachable
    case providerAuthFailed
    case readinessFailed
}

extension ConsumerAIAccessFailureKind {
    var title: String {
        switch self {
        case .gatewayUnreachable:
            return "AI operator is offline"
        case .providerAuthFailed:
            return "AI account needs attention"
        case .readinessFailed:
            return "AI is reachable, but not ready"
        }
    }
}

struct ConsumerModelsModelListPayload: Decodable {
    let currentModel: String?
    let options: [ConsumerSelectableModel]
}

struct ConsumerModelsSetPayload: Decodable {
    let ok: Bool
    let model: String
}

struct ConsumerModelsReadinessProbePayload: Decodable {
    let provider: String
    let model: String?
    let profileId: String?
    let label: String
    let source: String
    let mode: String?
    let status: String
}

@MainActor
@Observable
final class ConsumerModelSetupModel {
    enum AuthCategory: String, CaseIterable, Identifiable {
        case subscription
        case apiKey

        var id: String { self.rawValue }

        var title: String {
            switch self {
            case .subscription:
                return "Subscription"
            case .apiKey:
                return "API key"
            }
        }
    }

    typealias ReadinessProbe = @Sendable () async throws -> ConsumerModelsReadinessPayload
    typealias AuthOptionsLoader = @Sendable () async throws -> ConsumerModelsAuthListPayload
    typealias AuthApply = @Sendable (_ optionId: String, _ secret: String?) async throws -> ConsumerModelsAuthApplyPayload
    typealias ModelsLoader = @Sendable () async throws -> ConsumerModelsModelListPayload
    typealias ModelApply = @Sendable (_ modelId: String) async throws -> ConsumerModelsSetPayload
    typealias RuntimeOwnershipBlocker = @Sendable () -> String?
    typealias RestartGateway = @Sendable () async -> Void

    enum Phase: Equatable {
        case idle
        case checking
        case ready(String)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var statusLine: String?
    private(set) var authOptions: [ConsumerModelsAuthOptionPayload] = []
    private(set) var authOptionsLoaded = false
    private(set) var authError: String?
    private(set) var authNotes: [String] = []
    private(set) var applyingOptionId: String?
    private(set) var activeAuthOptionId: String?
    private(set) var activeModelId: String?
    private(set) var modelOptions: [ConsumerSelectableModel] = []
    private(set) var modelError: String?
    private(set) var applyingModelId: String?
    private(set) var failureKind: ConsumerAIAccessFailureKind?
    private(set) var isRestartingOperator = false
    private(set) var activeAccessTitle: String?
    private(set) var activeAccessDetail: String?
    var authCategory: AuthCategory = .subscription
    var authSectionExpanded = true
    var alternateMethodExpanded = false
    var selectedOptionId: String?
    var selectedModelId: String?
    var draftSecret = ""
    private let probeReadiness: ReadinessProbe
    private let listAuthOptions: AuthOptionsLoader
    private let applyAuth: AuthApply
    private let listModels: ModelsLoader
    private let applyModel: ModelApply
    private let runtimeOwnershipBlocker: RuntimeOwnershipBlocker
    private let restartGateway: RestartGateway
    private var lastReadiness: ConsumerModelsReadinessPayload?

    init(
        probeReadiness: ReadinessProbe? = nil,
        listAuthOptions: AuthOptionsLoader? = nil,
        applyAuth: AuthApply? = nil,
        listModels: ModelsLoader? = nil,
        applyModel: ModelApply? = nil,
        runtimeOwnershipBlocker: RuntimeOwnershipBlocker? = nil,
        restartGateway: RestartGateway? = nil)
    {
        self.probeReadiness = probeReadiness ?? Self.gatewayReadinessProbe
        let usesMockedDependencies =
            probeReadiness != nil ||
            listAuthOptions != nil ||
            applyAuth != nil ||
            listModels != nil ||
            applyModel != nil ||
            restartGateway != nil
        self.listAuthOptions = listAuthOptions ?? {
            if usesMockedDependencies {
                return ConsumerModelsAuthListPayload(options: [], activeOptionId: nil)
            }
            return try await Self.gatewayAuthOptionsLoader()
        }
        self.applyAuth = applyAuth ?? Self.gatewayAuthApply
        self.listModels = listModels ?? Self.gatewayModelsLoader
        self.applyModel = applyModel ?? Self.gatewayModelApply
        self.runtimeOwnershipBlocker = runtimeOwnershipBlocker ?? {
            if usesMockedDependencies {
                return nil
            }
            return GatewayLaunchAgentManager.runtimeOwnershipBlockerMessage()
        }
        self.restartGateway = restartGateway ?? {
            await GatewayConnection.shared.shutdown()
            await ControlChannel.shared.disconnect()
            await GatewayProcessManager.shared.restartManagedGateway()
            try? await ControlChannel.shared.configure(mode: .local)
        }
    }

    var isComplete: Bool {
        if case .ready = self.phase {
            return true
        }
        return false
    }

    var selectedOption: ConsumerModelsAuthOptionPayload? {
        let selectedId = self.selectedOptionId ?? self.activeAuthOptionId ?? self.authOptions.first?.id
        return self.authOptions.first { $0.id == selectedId }
    }

    var isApplyingAuth: Bool {
        self.applyingOptionId != nil
    }

    var isApplyingModel: Bool {
        self.applyingModelId != nil
    }

    var canRestartOperator: Bool {
        guard self.failureKind != .providerAuthFailed else { return false }
        guard self.failureKind != nil else { return false }
        return !self.isRestartingOperator
    }

    var hasModelOptions: Bool {
        !self.modelOptions.isEmpty
    }

    var hasModelError: Bool {
        !(self.modelError ?? "").isEmpty
    }

    var availableAuthCategories: [AuthCategory] {
        var categories: [AuthCategory] = []
        for option in self.authOptions {
            let category = option.authCategory
            if !categories.contains(category) {
                categories.append(category)
            }
        }
        return categories
    }

    var visibleAuthOptions: [ConsumerModelsAuthOptionPayload] {
        let scoped = self.authOptions.filter { $0.authCategory == self.authCategory }
        return scoped.isEmpty ? self.authOptions : scoped
    }

    var visibleAuthProviders: [ConsumerAuthProviderChoice] {
        var seen = Set<String>()
        var providers: [ConsumerAuthProviderChoice] = []
        for option in self.visibleAuthOptions {
            guard seen.insert(option.providerId).inserted else { continue }
            providers.append(.init(id: option.providerId, label: option.providerLabel))
        }
        return providers
    }

    var selectedProviderId: String? {
        let current = self.selectedOption?.providerId
        if let current, self.visibleAuthProviders.contains(where: { $0.id == current }) {
            return current
        }
        return self.visibleAuthProviders.first?.id
    }

    var selectedProviderOptions: [ConsumerModelsAuthOptionPayload] {
        guard let providerId = self.selectedProviderId else { return [] }
        return self.visibleAuthOptions.filter { $0.providerId == providerId }
    }

    var selectedAlternateAuthOptions: [ConsumerModelsAuthOptionPayload] {
        guard let selectedOption = self.selectedOption else { return [] }
        return self.selectedProviderOptions.filter { $0.id != selectedOption.id }
    }

    func selectOption(_ optionId: String) {
        guard self.selectedOptionId != optionId else { return }
        self.selectedOptionId = optionId
        if let option = self.authOptions.first(where: { $0.id == optionId }) {
            self.authCategory = option.authCategory
        }
        self.alternateMethodExpanded = false
        self.draftSecret = ""
        self.authError = nil
        self.authNotes = []
    }

    func selectProvider(_ providerId: String) {
        // Provider choice should land on the cleanest default method for that
        // provider. Alternative methods remain available in the secondary
        // disclosure instead of polluting the main provider picker.
        guard let option = self.preferredOption(for: providerId) else { return }
        self.selectOption(option.id)
    }

    func selectAuthCategory(_ category: AuthCategory) {
        guard self.authCategory != category else { return }
        self.authCategory = category
        self.alternateMethodExpanded = false
        if let option = self.visibleAuthOptions.first {
            self.selectedOptionId = option.id
        }
        self.draftSecret = ""
        self.authError = nil
        self.authNotes = []
    }

    func refreshIfNeeded() async {
        switch self.phase {
        case .checking:
            return
        case .idle, .failed:
            break
        case .ready:
            return
        }
        // A transient gateway/auth probe failure should not stick forever in the
        // Settings card. When the view appears again after the runtime recovers,
        // allow one more live readiness check instead of forcing the user to
        // change auth/model state just to clear a stale error.
        await self.refresh()
    }

    func refreshOnAppActivationIfNeeded() async {
        // Settings can stay mounted while external auth/gateway recovery
        // happens elsewhere. Re-probe on app activation so stale readiness
        // errors do not linger after the runtime has already recovered.
        guard self.phase != .checking else { return }
        guard !self.isApplyingAuth else { return }
        guard !self.isApplyingModel else { return }
        guard !self.isRestartingOperator else { return }
        await self.refresh()
    }

    func refresh() async {
        self.phase = .checking
        self.statusLine = "Checking OpenClaw's AI access…"
        self.failureKind = nil

        if ProcessInfo.processInfo.environment["OPENCLAW_SKIP_RUNTIME_OWNERSHIP_BLOCKER"] != "1",
           let blocker = self.runtimeOwnershipBlocker()
        {
            // If launchd is pinned to a different checkout, do not let the UI
            // probe auth or model readiness. That would just lie about the real
            // runtime the user is about to rely on.
            self.phase = .failed(blocker)
            self.statusLine = blocker
            self.failureKind = nil
            self.authSectionExpanded = true
            return
        }

        do {
            let payload = try await self.probeReadiness()
            self.applyReadiness(payload)
            // The Settings switcher must stay available even when AI is already
            // healthy. Otherwise the card turns into a static status badge and
            // users cannot change provider/method without first breaking auth.
            await self.loadAuthOptionsIfNeeded()
            await self.syncModelOptions(readiness: payload)
        } catch {
            let detail = Self.consumerFriendlyReadinessError(error)
            self.failureKind = Self.consumerAccessFailureKind(for: error)
            self.phase = .failed(detail)
            self.statusLine = detail
            if self.failureKind != .gatewayUnreachable {
                await self.loadAuthOptionsIfNeeded()
            }
        }
    }

    func restartOperator() async {
        guard self.canRestartOperator else { return }
        self.isRestartingOperator = true
        defer { self.isRestartingOperator = false }

        self.phase = .checking
        self.statusLine = "Restarting AI operator…"
        await self.restartGateway()
        await self.refresh()
    }

    func loadAuthOptionsIfNeeded() async {
        guard !self.authOptionsLoaded else { return }
        do {
            let payload = try await self.listAuthOptions()
            self.authOptions = payload.options
            self.activeAuthOptionId = payload.activeOptionId
            self.authOptionsLoaded = true
            self.reconcileAuthSelection()
            self.syncActiveAccessFromReadiness()
        } catch {
            self.authError = error.localizedDescription
        }
    }

    func submitSelectedAuth() async {
        guard let option = self.selectedOption else {
            self.authError = "No sign-in option is available in this runtime."
            return
        }

        let secret = self.draftSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if option.inputKind.requiresSecret && secret.isEmpty {
            let label = option.inputLabel ?? "credential"
            self.authError = "Paste \(label.lowercased()) before continuing."
            return
        }

        self.applyingOptionId = option.id
        self.authError = nil
        self.authNotes = []
        do {
            let payload = try await self.applyAuth(option.id, option.inputKind.requiresSecret ? secret : nil)
            self.authNotes = payload.notes
            self.activeAuthOptionId = payload.optionId
            self.draftSecret = ""
            await self.refreshAfterAuthApply(
                optimisticReadiness: payload.readiness,
                defaultStatusLine: "Reconnecting AI operator after sign-in…")
        } catch {
            self.authError = error.localizedDescription
        }
        self.applyingOptionId = nil
    }

    func submitSelectedModel() async {
        guard let modelId = self.selectedModelId?.trimmingCharacters(in: .whitespacesAndNewlines), !modelId.isEmpty else {
            self.modelError = "Choose a model before saving."
            return
        }
        guard modelId != self.activeModelId else { return }

        self.applyingModelId = modelId
        self.modelError = nil
        do {
            _ = try await self.applyModel(modelId)
            await self.refresh()
        } catch {
            if await self.handleGatewayReconnectFailure(
                error,
                statusLine: "Reconnecting AI operator after saving the model…")
            {
                self.modelError = nil
            } else {
                self.modelError = error.localizedDescription
            }
        }
        self.applyingModelId = nil
    }

    private func refreshAfterAuthApply(
        optimisticReadiness: ConsumerModelsReadinessPayload,
        defaultStatusLine: String) async
    {
        // Auth apply can return a stale pre-restart readiness snapshot while the
        // gateway is still tearing down and rebinding with the new auth state.
        // Do not trust that optimistic response blindly or the UI can claim
        // "AI is ready" while the transport is already mid-restart.
        self.enterGatewayReconnectState(defaultStatusLine)

        if optimisticReadiness.consumerFailureKind == .providerAuthFailed || optimisticReadiness.status != "ready" {
            self.applyReadiness(optimisticReadiness)
            await self.syncModelOptions(readiness: optimisticReadiness)
            return
        }

        let delaysMs: [UInt64] = [150, 400, 900, 1_500]
        for (index, delayMs) in delaysMs.enumerated() {
            if index > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            do {
                let payload = try await self.probeReadiness()
                self.applyReadiness(payload)
                await self.syncModelOptions(readiness: payload)
                return
            } catch {
                if Self.consumerAccessFailureKind(for: error) == .gatewayUnreachable {
                    continue
                }
                let detail = Self.consumerFriendlyReadinessError(error)
                self.failureKind = Self.consumerAccessFailureKind(for: error)
                self.phase = .failed(detail)
                self.statusLine = detail
                self.authSectionExpanded = true
                return
            }
        }

        // If the gateway is still bouncing after the planned auth restart, keep
        // the UI honest: the operator is reconnecting, not ready. Users can
        // retry or the app can refresh on activation once the restart settles.
        self.phase = .failed("OpenClaw is still reconnecting its AI operator after sign-in. Wait a moment, then try again.")
        self.statusLine = "OpenClaw is still reconnecting its AI operator after sign-in. Wait a moment, then try again."
        self.failureKind = .gatewayUnreachable
        self.activeModelId = nil
        self.authSectionExpanded = true
    }

    private func handleGatewayReconnectFailure(
        _ error: Error,
        statusLine: String) async -> Bool
    {
        guard Self.consumerAccessFailureKind(for: error) == .gatewayUnreachable else {
            return false
        }

        // Model changes can race with the same gateway restart window seen after
        // auth apply. If the transport is gone, clear the stale ready badge and
        // re-probe instead of pinning a low-level socket error under an "AI is
        // ready" heading.
        self.enterGatewayReconnectState(statusLine)
        await self.refresh()
        return true
    }

    private func enterGatewayReconnectState(_ statusLine: String) {
        self.phase = .checking
        self.statusLine = statusLine
        self.failureKind = nil
        self.activeModelId = nil
    }

    private func applyReadiness(_ payload: ConsumerModelsReadinessPayload) {
        self.lastReadiness = payload
        if payload.status == "ready" {
            let trimmedModel = payload.defaultModel?.trimmingCharacters(in: .whitespacesAndNewlines)
            let display = (trimmedModel?.isEmpty == false ? trimmedModel : nil) ?? "the default model"
            self.activeModelId = trimmedModel
            self.phase = .ready(display)
            self.statusLine = "AI ready on \(display)."
            self.failureKind = nil
            self.authSectionExpanded = false
            self.syncActiveAccessFromReadiness()
            return
        }

        let detail = payload.consumerFailureMessage
        self.activeModelId = nil
        self.failureKind = payload.consumerFailureKind
        self.phase = .failed(detail)
        self.statusLine = detail
        self.authSectionExpanded = true
        self.syncActiveAccessFromReadiness()
    }

    private func syncModelOptions(readiness: ConsumerModelsReadinessPayload) async {
        guard readiness.status == "ready" else {
            self.modelOptions = []
            self.selectedModelId = nil
            self.modelError = nil
            return
        }

        do {
            let payload = try await self.listModels()
            self.modelOptions = payload.options

            // Keep the user's active/default model selected when it is in the
            // curated shortlist. Otherwise fall back to the first valid option.
            let preferred =
                payload.currentModel?.trimmingCharacters(in: .whitespacesAndNewlines) ??
                readiness.defaultModel?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let preferred, self.modelOptions.contains(where: { $0.id == preferred }) {
                self.selectedModelId = preferred
            } else if let selected = self.selectedModelId,
                      self.modelOptions.contains(where: { $0.id == selected })
            {
                self.selectedModelId = selected
            } else {
                self.selectedModelId = self.modelOptions.first?.id
            }
            self.modelError = nil
        } catch {
            self.modelOptions = []
            self.selectedModelId = nil
            self.modelError = error.localizedDescription
        }
    }

    private func reconcileAuthSelection() {
        let availableCategories = self.availableAuthCategories
        if !availableCategories.contains(self.authCategory), let firstCategory = availableCategories.first {
            self.authCategory = firstCategory
        }

        if let activeOption = self.resolveActiveOption() {
            self.selectedOptionId = activeOption.id
            self.authCategory = activeOption.authCategory
            return
        }

        if let selectedOptionId = self.selectedOptionId,
           self.visibleAuthOptions.contains(where: { $0.id == selectedOptionId })
        {
            return
        }

        self.selectedOptionId = self.visibleAuthOptions.first?.id ?? self.authOptions.first?.id
    }

    private func preferredOption(for providerId: String) -> ConsumerModelsAuthOptionPayload? {
        let options = self.visibleAuthOptions.filter { $0.providerId == providerId }
        if let current = self.selectedOption, current.providerId == providerId {
            return current
        }
        return options.first(where: { $0.inputKind == .none })
            ?? options.first(where: { !$0.inputKind.requiresSecret })
            ?? options.first
    }

    private func resolveActiveOption() -> ConsumerModelsAuthOptionPayload? {
        if let activeAuthOptionId {
            return self.authOptions.first { $0.id == activeAuthOptionId }
        }
        guard let readiness = self.lastReadiness else { return nil }
        guard let providerId = readiness.probe?.provider ?? Self.providerId(from: readiness.defaultModel) else {
            return nil
        }
        let normalizedMode = readiness.probe?.mode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.authOptions.first { option in
            guard option.providerId == providerId else { return false }
            guard let normalizedMode else { return false }
            return option.methodKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalizedMode
        }
    }

    private func syncActiveAccessFromReadiness() {
        guard let readiness = self.lastReadiness else {
            self.activeAccessTitle = nil
            self.activeAccessDetail = nil
            return
        }

        if readiness.mode == "managed", readiness.probe?.provider == "openai-codex" {
            self.activeAccessTitle = "OpenClaw-managed ChatGPT / Codex"
            self.activeAccessDetail = "Shared founder auth is active for this runtime."
            return
        }

        if let activeOption = self.resolveActiveOption() {
            self.activeAccessTitle = Self.activeAccessTitle(for: activeOption)
            self.activeAccessDetail = Self.activeAccessDetail(for: activeOption)
            return
        }

        guard let providerId = readiness.probe?.provider ?? Self.providerId(from: readiness.defaultModel) else {
            self.activeAccessTitle = nil
            self.activeAccessDetail = nil
            return
        }
        self.activeAccessTitle = Self.fallbackActiveAccessTitle(providerId: providerId, probeMode: readiness.probe?.mode)
        self.activeAccessDetail = readiness.probe?.label
    }

    private static func providerId(from modelRef: String?) -> String? {
        guard let modelRef else { return nil }
        let trimmed = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = trimmed.firstIndex(of: "/") else { return nil }
        let provider = trimmed[..<slash].trimmingCharacters(in: .whitespacesAndNewlines)
        return provider.isEmpty ? nil : provider
    }

    private static func activeAccessTitle(for option: ConsumerModelsAuthOptionPayload) -> String {
        switch option.inputKind {
        case .none:
            return "\(option.providerLabel) login"
        case .apiKey:
            return "\(option.providerLabel) API key"
        case .token:
            return "\(option.providerLabel) setup token"
        }
    }

    private static func activeAccessDetail(for option: ConsumerModelsAuthOptionPayload) -> String {
        switch option.inputKind {
        case .none:
            return "Uses the current sign-in already available on this Mac."
        case .apiKey:
            return "Uses a tester-owned API key for this runtime."
        case .token:
            return "Uses a Claude setup token stored in this runtime."
        }
    }

    private static func fallbackActiveAccessTitle(providerId: String, probeMode: String?) -> String {
        let providerLabel = switch providerId {
        case "openai-codex":
            "ChatGPT / Codex"
        case "openai":
            "OpenAI"
        case "anthropic":
            "Claude"
        default:
            providerId
        }

        switch probeMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "api_key":
            return "\(providerLabel) API key"
        case "token":
            return "\(providerLabel) setup token"
        case "oauth":
            return "\(providerLabel) login"
        default:
            return providerLabel
        }
    }

    private static func gatewayReadinessProbe() async throws -> ConsumerModelsReadinessPayload {
        return try await GatewayConnection.shared.requestDecoded(
            method: .modelsReadiness,
            timeoutMs: 20_000)
    }

    private static func consumerFriendlyReadinessError(_ error: Error) -> String {
        let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !detail.isEmpty else {
            return "OpenClaw could not check AI access yet. Try again in a moment."
        }

        if Self.consumerAccessFailureKind(for: error) == .gatewayUnreachable
        {
            return "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again."
        }

        return detail
    }

    private static func consumerAccessFailureKind(for error: Error) -> ConsumerAIAccessFailureKind {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch URLError.Code(rawValue: nsError.code) {
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet:
                return .gatewayUnreachable
            default:
                break
            }
        }

        let lowercased = nsError.localizedDescription.lowercased()
        if lowercased.contains("refresh_token_reused")
            || lowercased.contains("invalid_grant")
            || lowercased.contains("reauth")
            || lowercased.contains("sign in again")
            || lowercased.contains("sign-in again")
        {
            return .providerAuthFailed
        }
        if lowercased.contains("gateway connect")
            || lowercased.contains("could not connect to the server")
            || lowercased.contains("connection refused")
            || lowercased.contains("gateway not configured")
            || lowercased.contains("gateway closed")
            || lowercased.contains("gateway connection dropped")
            || lowercased.contains("gateway not connected")
            || lowercased.contains("socket is not connected")
        {
            return .gatewayUnreachable
        }

        return .readinessFailed
    }

    private static func gatewayAuthOptionsLoader() async throws -> ConsumerModelsAuthListPayload {
        return try await GatewayConnection.shared.requestDecoded(
            method: .modelsAuthList,
            timeoutMs: 20_000)
    }

    private static func gatewayAuthApply(
        optionId: String,
        secret: String?) async throws -> ConsumerModelsAuthApplyPayload
    {
        var params: [String: AnyCodable] = ["optionId": AnyCodable(optionId)]
        if let secret {
            params["secret"] = AnyCodable(secret)
        }
        return try await GatewayConnection.shared.requestDecoded(
            method: .modelsAuthApply,
            params: params,
            timeoutMs: 120_000)
    }

    private static func gatewayModelsLoader() async throws -> ConsumerModelsModelListPayload {
        return try await GatewayConnection.shared.requestDecoded(
            method: .modelsConsumerList,
            timeoutMs: 20_000)
    }

    private static func gatewayModelApply(modelId: String) async throws -> ConsumerModelsSetPayload {
        return try await GatewayConnection.shared.requestDecoded(
            method: .modelsConsumerApply,
            params: ["model": AnyCodable(modelId)],
            timeoutMs: 20_000)
    }
}

struct ConsumerModelsReadinessPayload: Decodable {
    let status: String
    let defaultModel: String?
    let summary: String
    let reasonCodes: [String]
    let mode: String?
    let authMode: String?
    let sharedProfileId: String?
    let probe: ConsumerModelsReadinessProbePayload?

    init(
        status: String,
        defaultModel: String?,
        summary: String,
        reasonCodes: [String],
        mode: String? = nil,
        authMode: String? = nil,
        sharedProfileId: String? = nil,
        probe: ConsumerModelsReadinessProbePayload? = nil)
    {
        self.status = status
        self.defaultModel = defaultModel
        self.summary = summary
        self.reasonCodes = reasonCodes
        self.mode = mode
        self.authMode = authMode
        self.sharedProfileId = sharedProfileId
        self.probe = probe
    }

    var consumerFailureKind: ConsumerAIAccessFailureKind {
        let lowercasedSummary = self.summary.lowercased()
        if self.reasonCodes.contains("missing_auth")
            || self.reasonCodes.contains("probe_auth_failed")
            || lowercasedSummary.contains("refresh_token_reused")
            || lowercasedSummary.contains("sign in again")
            || lowercasedSummary.contains("sign-in again")
            || lowercasedSummary.contains("reauth")
        {
            return .providerAuthFailed
        }
        return .readinessFailed
    }

    var consumerFailureMessage: String {
        if self.status == "ready" {
            return "OpenClaw's AI access is ready."
        }
        // Consumer onboarding needs a plain-English blocker. The gateway already
        // computed the truthful live-probe summary, so surface that instead of
        // re-deriving auth state from stale local snapshots.
        let trimmedSummary = self.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedSummary.isEmpty {
            return trimmedSummary
        }
        switch self.consumerFailureKind {
        case .gatewayUnreachable:
            return "OpenClaw could not reach the local consumer gateway yet."
        case .providerAuthFailed:
            return "OpenClaw could not verify a usable AI account for this runtime yet."
        case .readinessFailed:
            return "OpenClaw reached the AI provider, but it is not ready yet."
        }
    }
}

struct ConsumerModelsAuthListPayload: Decodable {
    let options: [ConsumerModelsAuthOptionPayload]
    let activeOptionId: String?
}

struct ConsumerModelsAuthOptionPayload: Decodable, Equatable, Identifiable {
    enum InputKind: String, Decodable {
        case none
        case apiKey = "api_key"
        case token

        var requiresSecret: Bool {
            self != .none
        }
    }

    let id: String
    let providerId: String
    let providerLabel: String
    let title: String
    let detail: String
    let inputKind: InputKind
    let submitLabel: String
    let inputLabel: String?
    let inputHelp: String?
    let inputPlaceholder: String?
    let methodKind: String

    var authCategory: ConsumerModelSetupModel.AuthCategory {
        self.inputKind == .apiKey ? .apiKey : .subscription
    }
}

struct ConsumerModelsAuthApplyPayload: Decodable {
    let optionId: String
    let providerId: String
    let methodId: String
    let defaultModel: String?
    let notes: [String]
    let profileIds: [String]
    let readiness: ConsumerModelsReadinessPayload
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
        // Consumer browser setup still captures a clone target for the managed
        // fallback lane, but it should not force clone mode as the browser
        // default after the core product moved away from the old MVP design.
        if (browser["defaultProfile"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == consumerBrowserProfileName {
            browser.removeValue(forKey: "defaultProfile")
        }
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
        runBrowserStatus: ((String, [String], TimeInterval) async -> ConsumerShellCommandResult)? = nil,
        sleep: (@Sendable (UInt64) async -> Void)? = nil,
        now: (@Sendable () -> Date)? = nil) async -> String?
    {
        if let expectedProfile {
            let persistedProfile = self.persistedConsumerBrowserSourceProfileName() ?? ""
            if persistedProfile != expectedProfile.directoryName {
                return "OpenClaw saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."
            }
        }

        // Saving the chosen Chrome profile can trigger a gateway restart at the
        // exact moment onboarding probes browser readiness. On this machine the
        // supervised restart can take well beyond a couple of seconds, so a tiny
        // fixed retry window still surfaces a fake-broken browser card and forces
        // the user to hammer "Try Again" until the runtime restabilizes.
        // Keep the probe on the real browser-status path, but retry transient
        // loopback disconnects for long enough to survive the slow reconnect
        // window after Accessibility/permissions restarts.
        let browserStatusArgs = ["--json", "--browser-profile", consumerBrowserProfileName, "status"]
        let sleepImpl = sleep ?? { duration in
            try? await Task.sleep(nanoseconds: duration)
        }
        let retryIntervalNanos: UInt64 = 2_000_000_000
        let browserStatusCommandTimeout: TimeInterval = 60
        let nowImpl = now ?? Date.init
        let deadline = nowImpl().addingTimeInterval(GatewayProcessManager.gatewayReadinessTimeout + 60)
        var attempt = 0

        while true {
            attempt += 1
            let result = if let runBrowserStatus {
                await runBrowserStatus("browser", browserStatusArgs, browserStatusCommandTimeout)
            } else {
                await ConsumerSetupCommandRunner.runOpenClaw(
                    subcommand: "browser",
                    extraArgs: browserStatusArgs,
                    timeout: browserStatusCommandTimeout)
            }

            if !result.success {
                let message = ConsumerSetupCommandRunner.bestEffortMessage(for: result)
                if ConsumerSetupCommandRunner.isDiskFullFailure(message) {
                    return "This Mac is out of disk space, so OpenClaw could not finish browser setup. Free some space and try again."
                }
                if ConsumerSetupCommandRunner.isTransientBrowserStatusFailure(message) &&
                    nowImpl().addingTimeInterval(1) < deadline
                {
                    await sleepImpl(retryIntervalNanos)
                    continue
                }
                return "OpenClaw saved the Chrome profile, but browser readiness failed. \(message)"
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
}

struct ConsumerModelSetupCardContent: View {
    @Bindable var model: ConsumerModelSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("AI access")
                    .font(.headline)
                Text("Choose which AI provider and billing path this Mac should use.")
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
                self.failureCallout(message: message)
            }

            if let activeAccessTitle = self.model.activeAccessTitle, !activeAccessTitle.isEmpty {
                self.activeAccessSummary(
                    title: activeAccessTitle,
                    detail: self.model.activeAccessDetail)
            }

            if self.model.isComplete,
               (self.model.hasModelOptions || self.model.hasModelError)
            {
                Divider()
                    .padding(.vertical, 2)

                self.modelPickerSection()
            }

            if let option = self.model.selectedOption {
                Divider()
                    .padding(.vertical, 2)

                if self.model.isComplete {
                    DisclosureGroup("Switch provider or auth mode", isExpanded: self.$model.authSectionExpanded) {
                        self.authEditor(option: option, isReady: true)
                            .padding(.top, 8)
                    }
                } else {
                    self.authEditor(option: option, isReady: false)
                }
            } else if let authError = self.model.authError, !authError.isEmpty {
                Text(authError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task {
            await self.model.refreshIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await self.model.refreshOnAppActivationIfNeeded() }
        }
    }

    @ViewBuilder
    private func modelPickerSection() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Model")
                .font(.subheadline.weight(.semibold))
            Text("Pick a small curated default model for this runtime. OpenClaw will re-check readiness after you switch.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.model.hasModelOptions {
                Picker("Model", selection: Binding(
                    get: { self.model.selectedModelId ?? self.model.activeModelId ?? "" },
                    set: { self.model.selectedModelId = $0 }))
                {
                    ForEach(self.model.modelOptions) { model in
                        Text("\(model.title) · \(model.detail)")
                            .tag(model.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }

            if let activeModelId = self.model.activeModelId, !activeModelId.isEmpty {
                Text("Current default: \(activeModelId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let modelError = self.model.modelError, !modelError.isEmpty {
                Text(modelError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button("Save Model") {
                    Task { await self.model.submitSelectedModel() }
                }
                .buttonStyle(.bordered)
                .disabled(
                    self.model.isApplyingModel ||
                    self.model.modelOptions.isEmpty ||
                    self.model.selectedModelId == nil ||
                    self.model.selectedModelId == self.model.activeModelId)

                if self.model.isApplyingModel {
                    ProgressView()
                        .controlSize(.small)
                }
            }
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

    private func activeAccessSummary(title: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Current access")
                .font(.caption.weight(.semibold))
            Text(title)
                .font(.subheadline.weight(.semibold))
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func failureCallout(message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(self.model.failureKind?.title ?? "AI setup still needs attention")
                .font(.subheadline.weight(.semibold))
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.model.canRestartOperator {
                Button {
                    Task { await self.model.restartOperator() }
                } label: {
                    if self.model.isRestartingOperator {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Restart AI Operator", systemImage: "arrow.clockwise")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.isRestartingOperator)
            }
        }
    }

    @ViewBuilder
    private func authEditor(option: ConsumerModelsAuthOptionPayload, isReady: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(isReady ? "Switch AI provider or billing source" : "Use your own AI account")
                .font(.subheadline.weight(.semibold))
            Text(
                isReady
                    ? "You’re already ready to run tasks. Change this only if you want a different provider, subscription, setup token, or API key. Credentials stay in this runtime’s local auth state, not in the app bundle."
                    : "Choose how OpenClaw should use your own subscription, setup token, or API key. Credentials stay in this runtime’s local auth state, not in the app bundle.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.model.availableAuthCategories.count > 1 {
                Picker("Access type", selection: Binding(
                    get: { self.model.authCategory },
                    set: { self.model.selectAuthCategory($0) }))
                {
                    ForEach(self.model.availableAuthCategories) { category in
                        Text(category.title)
                            .tag(category)
                    }
                }
                .pickerStyle(.segmented)
            }

            Picker("Provider", selection: Binding(
                get: { self.model.selectedProviderId ?? option.providerId },
                set: { self.model.selectProvider($0) }))
            {
                ForEach(self.model.visibleAuthProviders) { provider in
                    Text(provider.label)
                        .tag(provider.id)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Text(option.title)
                .font(.caption.weight(.semibold))

            Text(option.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.model.selectedProviderOptions.count > 1 {
                DisclosureGroup(
                    "Other \(option.providerLabel) sign-in methods",
                    isExpanded: self.$model.alternateMethodExpanded)
                {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Use this only if the main \(option.providerLabel) path is not the right fit on this Mac.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        Picker("Method", selection: Binding(
                            get: { self.model.selectedOptionId ?? option.id },
                            set: { self.model.selectOption($0) }))
                        {
                            ForEach(self.model.selectedProviderOptions) { method in
                                Text(method.title)
                                    .tag(method.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                    }
                    .padding(.top, 6)
                }
            }

            if option.inputKind.requiresSecret {
                VStack(alignment: .leading, spacing: 6) {
                    if let inputLabel = option.inputLabel {
                        Text(inputLabel)
                            .font(.caption.weight(.semibold))
                    }
                    SecureField(
                        option.inputPlaceholder ?? "",
                        text: self.$model.draftSecret)
                    if let inputHelp = option.inputHelp, !inputHelp.isEmpty {
                        Text(inputHelp)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if let authError = self.model.authError, !authError.isEmpty {
                Text(authError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let note = self.model.authNotes.last, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button(option.submitLabel) {
                    Task { await self.model.submitSelectedAuth() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.isApplyingAuth)

                if self.model.isApplyingAuth {
                    ProgressView()
                        .controlSize(.small)
                }

                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .disabled(self.model.isApplyingAuth)
            }
        }
    }
}
