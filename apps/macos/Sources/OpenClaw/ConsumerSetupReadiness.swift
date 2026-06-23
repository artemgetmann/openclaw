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

    static func isMissingBuildOutputFailure(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("missing dist/entry") ||
            normalized.contains("missing dist/index") ||
            normalized.contains("build output")
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
    case runtimeUpdateBlocked
}

extension ConsumerAIAccessFailureKind {
    var title: String {
        switch self {
        case .gatewayUnreachable:
            return "\(AppFlavor.current.appName) is still starting"
        case .providerAuthFailed:
            return "AI model needs attention"
        case .readinessFailed:
            return "AI access needs a quick reset"
        case .runtimeUpdateBlocked:
            return "AI access needs attention"
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
    private static let logger = Logger(subsystem: "ai.openclaw", category: "consumer.ai-access")

    enum AuthCategory: String, CaseIterable, Identifiable {
        case subscription
        case apiKey

        var id: String { self.rawValue }

        var title: String {
            switch self {
            case .subscription:
                return "Account login"
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
    typealias RecoverySleep = @Sendable (_ nanoseconds: UInt64) async -> Void

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
    private(set) var chatGPTSignInURL: URL?
    private(set) var isWaitingForChatGPTSignIn = false
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
    var signInHelpExpanded = false
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
    private let restartGatewayTimeoutSeconds: Double
    private let recoveryProbeDelaysMs: [UInt64]
    private let runtimeOwnershipBypassProbeDelaysMs: [UInt64]
    private let recoverySleep: RecoverySleep
    private let readinessProbeTimeoutSeconds: Double
    private let postAuthReconnectProbeDelaysMs: [UInt64]
    private var lastReadiness: ConsumerModelsReadinessPayload?
    private var recoveryTask: Task<Void, Never>?
    private var recoveryAttempt = 0

    init(
        probeReadiness: ReadinessProbe? = nil,
        listAuthOptions: AuthOptionsLoader? = nil,
        applyAuth: AuthApply? = nil,
        listModels: ModelsLoader? = nil,
        applyModel: ModelApply? = nil,
        runtimeOwnershipBlocker: RuntimeOwnershipBlocker? = nil,
        restartGateway: RestartGateway? = nil,
        restartGatewayTimeoutSeconds: Double? = nil,
        readinessProbeTimeoutSeconds: Double? = nil,
        gatewayRecoveryProbeDelaysMs: [UInt64]? = nil,
        runtimeOwnershipBypassProbeDelaysMs: [UInt64]? = nil,
        gatewayRecoverySleep: RecoverySleep? = nil,
        postAuthReconnectProbeDelaysMs: [UInt64]? = nil)
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
        // Cold-start readiness can briefly lag the UI. Keep the first probe
        // bounded so the onboarding card can fail open and retry on the next
        // activation instead of sitting on a permanent spinner.
        self.restartGatewayTimeoutSeconds = restartGatewayTimeoutSeconds ?? 10.0
        self.readinessProbeTimeoutSeconds = readinessProbeTimeoutSeconds ?? 20.0
        // macOS device/network prompts can resolve while onboarding stays active,
        // so NSApplication.didBecomeActive may never fire. Quietly re-probe
        // transient gateway failures instead of trapping the user on stale copy.
        self.recoveryProbeDelaysMs = gatewayRecoveryProbeDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 12_000]
        // Runtime ownership repair restarts launchd, so the socket can be
        // temporarily closed even when the packaged helper is about to become
        // ready. Give the live readiness override its own short reconnect
        // window before pinning Settings to the manual repair callout.
        self.runtimeOwnershipBypassProbeDelaysMs = runtimeOwnershipBypassProbeDelaysMs ?? [0, 500, 1_500, 3_000, 6_000, 10_000]
        self.recoverySleep = gatewayRecoverySleep ?? { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        }
        self.postAuthReconnectProbeDelaysMs = postAuthReconnectProbeDelaysMs ?? [150, 400, 900, 1_500]
    }

    var isComplete: Bool {
        guard !self.isWaitingForChatGPTSignIn, !self.isApplyingAuth else {
            return false
        }
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

    var hasLoadedAuthChoices: Bool {
        self.authOptionsLoaded && !self.authOptions.isEmpty
    }

    var isAuthChoiceInteractionBlocked: Bool {
        guard self.failureKind == .gatewayUnreachable || self.failureKind == .runtimeUpdateBlocked else {
            return false
        }
        // Readiness can fail because the current/default model is not signed in yet.
        // If the gateway already returned setup choices, keep those choices live so
        // the user can fix auth instead of trapping them behind the failed probe.
        return !self.hasLoadedAuthChoices
    }

    var canChooseAnotherAccessMethod: Bool {
        guard !self.isRestartingOperator, !self.isAuthChoiceInteractionBlocked else { return false }
        guard self.authOptionsLoaded else { return false }
        return self.hasAPIKeySupport
    }

    var canShowChatGPTSignInHelp: Bool {
        self.isWaitingForChatGPTSignIn && self.chatGPTSignInURL != nil
    }

    var canOpenChatGPTSignInAgain: Bool {
        self.chatGPTSignInURL != nil
    }

    var hasModelOptions: Bool {
        !self.modelOptions.isEmpty
    }

    var hasModelError: Bool {
        !(self.modelError ?? "").isEmpty
    }

    var showActiveAccessSummary: Bool {
        self.isComplete && (self.activeAccessTitle?.isEmpty == false)
    }

    var showsAdvancedAuthControls: Bool {
        self.availableAuthCategories.count > 1 ||
            self.visibleAuthProviders.count > 1 ||
            self.selectedProviderOptions.count > 1
    }

    var shouldShowReadinessFailureCallout: Bool {
        guard self.failureKind == .providerAuthFailed else { return true }
        return self.selectedOption == nil
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
            providers.append(.init(id: option.providerId, label: option.consumerProviderLabel))
        }
        return providers
    }

    var readyAuthProviders: [ConsumerAuthProviderChoice] {
        let providers = self.visibleAuthProviders
        guard
            self.authCategory == .subscription,
            let selectedOption = self.selectedOption,
            selectedOption.providerId == "openai-codex",
            selectedOption.inputKind == .none
        else {
            return providers
        }
        return providers.filter { $0.id != "openai-codex" }
    }

    func preferredProviderId(for providers: [ConsumerAuthProviderChoice], fallback: String) -> String {
        let current = self.selectedProviderId ?? fallback
        if providers.contains(where: { $0.id == current }) {
            return current
        }
        return providers.first?.id ?? current
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

    var chatGPTSubscriptionOption: ConsumerModelsAuthOptionPayload? {
        self.authOptions.first { option in
            option.providerId == "openai-codex" && option.inputKind == .none
        }
    }

    var claudeSubscriptionOption: ConsumerModelsAuthOptionPayload? {
        self.authOptions.first { option in
            option.providerId == "anthropic" && option.inputKind == .none
        }
    }

    var apiKeyOptions: [ConsumerModelsAuthOptionPayload] {
        self.authOptions.filter { $0.inputKind == .apiKey }
    }

    var apiKeyProviders: [ConsumerAuthProviderChoice] {
        var seen = Set<String>()
        var providers: [ConsumerAuthProviderChoice] = []
        for option in self.apiKeyOptions {
            guard seen.insert(option.providerId).inserted else { continue }
            providers.append(.init(id: option.providerId, label: option.consumerProviderLabel))
        }
        return providers
    }

    var selectedAPIKeyOption: ConsumerModelsAuthOptionPayload? {
        if let selectedOption, selectedOption.inputKind == .apiKey {
            return selectedOption
        }
        let providerId = self.apiKeyProviders.first?.id
        return self.apiKeyOptions.first { $0.providerId == providerId } ?? self.apiKeyOptions.first
    }

    var selectedAPIKeyProviderId: String {
        self.selectedAPIKeyOption?.providerId ?? self.apiKeyProviders.first?.id ?? ""
    }

    var isAPIKeySelected: Bool {
        self.selectedOption?.inputKind == .apiKey
    }

    var hasAPIKeySupport: Bool {
        !self.apiKeyOptions.isEmpty
    }

    func isActiveAuthOption(_ option: ConsumerModelsAuthOptionPayload) -> Bool {
        self.isComplete && self.activeAuthOptionId == option.id
    }

    func selectAPIKeySetup() {
        guard let option = self.selectedAPIKeyOption ?? self.apiKeyOptions.first else { return }
        self.selectOption(option.id)
    }

    func chooseAnotherAccessMethod() {
        guard self.canChooseAnotherAccessMethod else { return }
        self.selectAPIKeySetup()
        self.alternateMethodExpanded = true
        self.authSectionExpanded = true
    }

    func selectAPIKeyProvider(_ providerId: String) {
        guard let option = self.apiKeyOptions.first(where: { $0.providerId == providerId }) else { return }
        self.selectOption(option.id)
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
        self.clearChatGPTSignInState()
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
        if let option = self.preferredVisibleAuthOption() {
            self.selectedOptionId = option.id
        }
        self.draftSecret = ""
        self.authError = nil
        self.authNotes = []
        self.clearChatGPTSignInState()
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
        // allow one more live readiness check without replacing the useful
        // failure copy with a spinner.
        await self.refresh(preservingDisplayedResult: self.hasDisplayedReadinessResult)
    }

    func refreshOnAppActivationIfNeeded() async {
        // Settings can stay mounted while external auth/gateway recovery
        // happens elsewhere. Re-probe on app activation so stale readiness
        // errors do not linger after the runtime has already recovered.
        guard self.phase != .checking else { return }
        guard !self.isApplyingAuth else { return }
        guard !self.isApplyingModel else { return }
        guard !self.isRestartingOperator else { return }
        await self.refresh(preservingDisplayedResult: self.hasDisplayedReadinessResult)
    }

    func refresh() async {
        await self.refresh(preservingDisplayedResult: false)
    }

    private var hasDisplayedReadinessResult: Bool {
        switch self.phase {
        case .ready, .failed:
            return true
        case .idle, .checking:
            return false
        }
    }

    private func refresh(
        preservingDisplayedResult: Bool,
        automaticGatewayRecovery: Bool = false,
        allowRuntimeOwnershipRepair: Bool = true) async
    {
        if !automaticGatewayRecovery {
            self.cancelRecoveryProbe(resetAttempt: true)
        }

        // Passive probes come from view re-appearance or app activation. They
        // should update stale data, but they should not make a healthy card look
        // like setup restarted unless there is no prior result to show.
        if !preservingDisplayedResult || !self.hasDisplayedReadinessResult {
            self.phase = .checking
            self.statusLine = "Checking \(AppFlavor.current.appName)'s AI access…"
            self.failureKind = nil
        }

        if !(await self.repairRuntimeOwnershipBlockerIfNeeded(allowRepair: allowRuntimeOwnershipRepair)) {
            self.authSectionExpanded = true
            return
        }

        do {
            let payload = try await self.probeReadinessWithTimeout()
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
            if self.failureKind == .gatewayUnreachable {
                // Readiness and auth-option listing are separate questions.
                // A cold-start readiness miss should not make the choices look
                // unsupported when the gateway can still answer the cheaper
                // auth-options request.
                await self.loadAuthOptionsIfNeeded(suppressError: true)
                self.scheduleRecoveryProbeIfNeeded()
            } else {
                self.cancelRecoveryProbe(resetAttempt: true)
                await self.loadAuthOptionsIfNeeded()
            }
        }
    }

    func restartOperator() async {
        guard self.canRestartOperator else { return }
        self.isRestartingOperator = true
        defer { self.isRestartingOperator = false }

        self.phase = .checking
        self.statusLine = "Restarting \(AppFlavor.current.appName)…"
        if !(await self.waitForRestartGateway()) {
            self.restoreGatewayRestartFailureState()
            await self.refresh(
                preservingDisplayedResult: true,
                automaticGatewayRecovery: true,
                allowRuntimeOwnershipRepair: false)
            return
        }
        await self.refresh(preservingDisplayedResult: false, allowRuntimeOwnershipRepair: false)
    }

    func loadAuthOptionsIfNeeded(suppressError: Bool = false) async {
        guard !self.authOptionsLoaded else { return }
        do {
            let payload = try await self.listAuthOptions()
            self.authOptions = payload.options
            self.activeAuthOptionId = payload.activeOptionId
            self.authOptionsLoaded = true
            self.reconcileAuthSelection()
            self.syncActiveAccessFromReadiness()
        } catch {
            // During startup recovery the main failure callout already tells
            // the user what to do. Do not stack a raw transport/auth-options
            // error under the choices when the helper is simply not ready yet.
            if !suppressError {
                self.authError = error.localizedDescription
            }
        }
    }

    func submitSelectedAuth() async {
        guard let option = self.selectedOption else {
            self.authError = "No sign-in option is available right now."
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
        let isChatGPTOAuth = option.providerId == "openai-codex" && option.inputKind == .none
        if isChatGPTOAuth {
            self.isWaitingForChatGPTSignIn = true
            self.signInHelpExpanded = false
        } else {
            self.clearChatGPTSignInState()
        }
        do {
            let payload = try await self.applyAuth(option.id, option.inputKind.requiresSecret ? secret : nil)
            self.authNotes = payload.notes
            if isChatGPTOAuth {
                self.chatGPTSignInURL = Self.signInURL(from: payload.notes)
            }
            self.activeAuthOptionId = payload.optionId
            self.draftSecret = ""
            await self.refreshAfterAuthApply(
                optimisticReadiness: payload.readiness,
                defaultStatusLine: "Reconnecting \(AppFlavor.current.appName) after sign-in…")
        } catch {
            if isChatGPTOAuth {
                self.authError = "Could not finish sign-in. Try again."
                self.isWaitingForChatGPTSignIn = false
            } else {
                self.authError = error.localizedDescription
            }
        }
        self.applyingOptionId = nil
    }

    func openChatGPTSignInLink() {
        guard let chatGPTSignInURL else { return }
        NSWorkspace.shared.open(chatGPTSignInURL)
    }

    func openChatGPTSignInAgain() async {
        if let chatGPTSignInURL {
            NSWorkspace.shared.open(chatGPTSignInURL)
            return
        }

        guard self.isWaitingForChatGPTSignIn, !self.isApplyingAuth else { return }
        await self.submitSelectedAuth()
    }

    func copyChatGPTSignInLink() {
        guard let chatGPTSignInURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(chatGPTSignInURL.absoluteString, forType: .string)
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
                statusLine: "Reconnecting \(AppFlavor.current.appName) after saving the model…")
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

        for (index, delayMs) in self.postAuthReconnectProbeDelaysMs.enumerated() {
            if index > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            do {
                let payload = try await self.probeReadinessWithTimeout()
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

        // If the gateway is still bouncing after the planned auth restart, do
        // not convert that expected reconnect window into a hard failure. Keep
        // the card in a reconnecting/checking state so the UI stays aligned
        // with the runtime transition instead of flashing a false transport
        // error that clears a moment later.
        self.enterGatewayReconnectState(defaultStatusLine)
    }

    private func probeReadinessWithTimeout() async throws -> ConsumerModelsReadinessPayload {
        let probe = self.probeReadiness
        let timeoutSeconds = self.readinessProbeTimeoutSeconds
        return try await AsyncTimeout.withTimeout(
            seconds: timeoutSeconds,
            onTimeout: {
                ReadinessProbeTimeoutError()
            },
            operation: {
                try await probe()
            })
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

    private func repairRuntimeOwnershipBlockerIfNeeded(allowRepair: Bool) async -> Bool {
        guard ProcessInfo.processInfo.environment["OPENCLAW_SKIP_RUNTIME_OWNERSHIP_BLOCKER"] != "1" else {
            return true
        }
        guard let blockerDetail = self.runtimeOwnershipBlocker() else {
            return true
        }

        // A runtime ownership blocker means the app would be probing a stale
        // helper. Repair launchd first, then re-run the same blocker gate before
        // any AI readiness/auth check is allowed to claim success.
        Self.logger.warning("AI access runtime helper repair needed: \(blockerDetail, privacy: .public)")
        self.cancelRecoveryProbe()
        guard allowRepair else {
            if await self.liveReadinessBypassesRuntimeOwnershipBlocker(blockerDetail: blockerDetail) {
                return true
            }
            await self.applyRuntimeOwnershipRepairFailureAfterLoadingAuthOptions(blockerDetail: blockerDetail)
            return false
        }

        self.phase = .checking
        self.statusLine = Self.runtimeOwnershipRepairInProgressStatusLine()
        self.failureKind = nil
        self.activeModelId = nil
        self.authSectionExpanded = true

        guard await self.waitForRestartGateway() else {
            if await self.liveReadinessBypassesRuntimeOwnershipBlocker(blockerDetail: blockerDetail) {
                return true
            }
            await self.applyRuntimeOwnershipRepairFailureAfterLoadingAuthOptions(blockerDetail: blockerDetail)
            return false
        }

        if let remainingBlocker = self.runtimeOwnershipBlocker() {
            Self.logger.warning("AI access runtime helper repair did not clear blocker: \(remainingBlocker, privacy: .public)")
            if await self.liveReadinessBypassesRuntimeOwnershipBlocker(blockerDetail: remainingBlocker) {
                return true
            }
            await self.applyRuntimeOwnershipRepairFailureAfterLoadingAuthOptions(blockerDetail: remainingBlocker)
            return false
        }

        Self.logger.info("AI access runtime helper repair cleared ownership blocker")
        return true
    }

    private func liveReadinessBypassesRuntimeOwnershipBlocker(blockerDetail: String) async -> Bool {
        // The launchd/plist blocker is a local safety check, but real readiness
        // is the product truth. If the packaged gateway can answer a live model
        // probe as ready, keeping Settings stuck on helper repair is worse than
        // trusting the working runtime. Non-ready or failed probes still leave
        // the repair blocker in control.
        let delays: [UInt64] = self.runtimeOwnershipBypassProbeDelaysMs.isEmpty
            ? [UInt64(0)]
            : self.runtimeOwnershipBypassProbeDelaysMs
        for (index, delayMs) in delays.enumerated() {
            if delayMs > 0 {
                await self.recoverySleep(delayMs * 1_000_000)
            }

            do {
                let payload = try await self.probeReadinessWithTimeout()
                guard payload.status == "ready" else {
                    Self.logger.warning("AI access runtime helper repair blocker stayed active after non-ready live readiness: \(blockerDetail, privacy: .public)")
                    return false
                }
                Self.logger.info("AI access live readiness passed despite runtime helper repair blocker: \(blockerDetail, privacy: .public)")
                return true
            } catch {
                guard Self.consumerAccessFailureKind(for: error) == .gatewayUnreachable else {
                    Self.logger.warning("AI access live readiness could not bypass runtime helper repair blocker: \(error.localizedDescription, privacy: .public)")
                    return false
                }

                if index == delays.count - 1 {
                    Self.logger.warning("AI access live readiness could not bypass runtime helper repair blocker after reconnect retries: \(error.localizedDescription, privacy: .public)")
                    return false
                }

                Self.logger.info("AI access live readiness retrying while runtime helper socket reconnects: \(error.localizedDescription, privacy: .public)")
            }
        }

        return false
    }

    private func applyRuntimeOwnershipRepairFailureAfterLoadingAuthOptions(blockerDetail: String) async {
        // A stale launchd/plist blocker is not the same as a dead setup API.
        // If the running gateway can still list auth methods, preserve those
        // controls so first-run users can connect ChatGPT/Claude/API keys.
        await self.loadAuthOptionsIfNeeded(suppressError: true)
        self.applyRuntimeOwnershipRepairFailure(blockerDetail: blockerDetail)
    }

    private func applyRuntimeOwnershipRepairFailure(blockerDetail: String) {
        Self.logger.warning("AI access runtime helper repair failed: \(blockerDetail, privacy: .public)")
        let detail = Self.runtimeOwnershipRepairFailureStatusLine()
        self.phase = .failed(detail)
        self.statusLine = detail
        self.failureKind = .runtimeUpdateBlocked
        self.activeModelId = nil
        self.authSectionExpanded = true
        self.scheduleRecoveryProbeIfNeeded()
    }

    private func enterGatewayReconnectState(_ statusLine: String) {
        self.cancelRecoveryProbe()
        self.phase = .checking
        self.statusLine = statusLine
        self.failureKind = nil
        self.activeModelId = nil
    }

    private func waitForRestartGateway() async -> Bool {
        let completion = RestartGatewayCompletion()
        let restartGateway = self.restartGateway

        // The gateway restart path crosses launchd and process shutdown. If it
        // wedges, the onboarding card still needs to become clickable again.
        let restartTask = Task {
            await restartGateway()
            await completion.markCompleted()
        }

        let timeoutNanos = UInt64(max(0, self.restartGatewayTimeoutSeconds) * 1_000_000_000)
        let deadline = ContinuousClock.now.advanced(by: .nanoseconds(Int(timeoutNanos)))
        while ContinuousClock.now < deadline {
            if await completion.isCompleted {
                return true
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        if await completion.isCompleted {
            return true
        }
        restartTask.cancel()
        return false
    }

    private func restoreGatewayRestartFailureState() {
        let statusLine = Self.gatewayRestartFailureStatusLine()
        self.cancelRecoveryProbe(resetAttempt: true)
        self.phase = .failed(statusLine)
        self.statusLine = statusLine
        self.failureKind = .gatewayUnreachable
        self.activeModelId = nil
        self.authSectionExpanded = true
    }

    private func applyReadiness(_ payload: ConsumerModelsReadinessPayload) {
        self.cancelRecoveryProbe(resetAttempt: true)
        self.lastReadiness = payload
        if payload.status == "ready" {
            self.clearChatGPTSignInState()
            let trimmedModel = payload.defaultModel?.trimmingCharacters(in: .whitespacesAndNewlines)
            let display = (trimmedModel?.isEmpty == false ? trimmedModel : nil) ?? "the default model"
            self.activeModelId = trimmedModel
            self.phase = .ready(display)
            self.statusLine = payload.consumerReadyStatusLine(modelDisplay: display)
            self.failureKind = nil
            self.authSectionExpanded = false
            self.syncActiveAccessFromReadiness()
            return
        }

        let detail = payload.consumerFailureMessage
        self.activeModelId = nil
        self.failureKind = payload.consumerFailureKind
        if payload.consumerFailureKind == .providerAuthFailed {
            self.isWaitingForChatGPTSignIn = false
        }
        self.phase = .failed(detail)
        self.statusLine = detail
        self.authSectionExpanded = true
        self.syncActiveAccessFromReadiness()
    }

    private func clearChatGPTSignInState() {
        self.isWaitingForChatGPTSignIn = false
        self.chatGPTSignInURL = nil
        self.signInHelpExpanded = false
    }

    private var shouldRetryRecoverableFailure: Bool {
        self.failureKind == .gatewayUnreachable || self.failureKind == .runtimeUpdateBlocked
    }

    private func scheduleRecoveryProbeIfNeeded() {
        guard self.shouldRetryRecoverableFailure else { return }
        guard self.recoveryTask == nil else { return }
        guard self.recoveryAttempt < self.recoveryProbeDelaysMs.count else { return }

        let delayMs = self.recoveryProbeDelaysMs[self.recoveryAttempt]
        self.recoveryAttempt += 1
        let sleep = self.recoverySleep
        self.recoveryTask = Task { [weak self] in
            await sleep(delayMs * 1_000_000)
            guard !Task.isCancelled else { return }
            await self?.runRecoveryProbe()
        }
    }

    private func runRecoveryProbe() async {
        self.recoveryTask = nil
        guard self.shouldRetryRecoverableFailure else { return }
        guard !self.isApplyingAuth else { return }
        guard !self.isApplyingModel else { return }
        guard !self.isRestartingOperator else { return }
        // A runtime-update failure may be stale launchd metadata after the
        // user-triggered restart. Re-check that blocker quietly, but do not
        // perform another hidden launchd restart from the background probe.
        let allowRuntimeOwnershipRepair = self.failureKind != .runtimeUpdateBlocked
        await self.refresh(
            preservingDisplayedResult: self.hasDisplayedReadinessResult,
            automaticGatewayRecovery: true,
            allowRuntimeOwnershipRepair: allowRuntimeOwnershipRepair)
    }

    private func cancelRecoveryProbe(resetAttempt: Bool = false) {
        self.recoveryTask?.cancel()
        self.recoveryTask = nil
        if resetAttempt {
            self.recoveryAttempt = 0
        }
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

        self.selectedOptionId = self.preferredVisibleAuthOption()?.id ?? self.visibleAuthOptions.first?.id ?? self.authOptions.first?.id
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

    private func preferredVisibleAuthOption() -> ConsumerModelsAuthOptionPayload? {
        if let chatgptLogin = self.visibleAuthOptions.first(where: { $0.providerId == "openai-codex" && $0.inputKind == .none }) {
            return chatgptLogin
        }
        return self.visibleAuthOptions.first(where: { $0.inputKind == .none })
            ?? self.visibleAuthOptions.first(where: { !$0.inputKind.requiresSecret })
            ?? self.visibleAuthOptions.first
    }

    private func resolveActiveOption() -> ConsumerModelsAuthOptionPayload? {
        if let activeAuthOptionId {
            return self.authOptions.first { $0.id == activeAuthOptionId }
        }
        guard let readiness = self.lastReadiness else { return nil }
        // A failed readiness probe describes the broken current/default model,
        // not the user's intended setup choice. Only map readiness back to an
        // active option after the gateway has proven that option is actually ready.
        guard readiness.status == "ready" else { return nil }
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

        guard readiness.status == "ready" else {
            self.activeAccessTitle = nil
            self.activeAccessDetail = nil
            return
        }

        if readiness.mode == "managed", readiness.probe?.provider == "openai-codex" {
            self.activeAccessTitle = "ChatGPT subscription"
            self.activeAccessDetail = "Uses your ChatGPT subscription on this Mac."
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
            return "\(option.consumerProviderLabel) login"
        case .apiKey:
            return "\(option.consumerProviderLabel) account"
        case .token:
            return "\(option.consumerProviderLabel) account"
        }
    }

    private static func activeAccessDetail(for option: ConsumerModelsAuthOptionPayload) -> String {
        switch option.inputKind {
        case .none:
            return "Uses the current sign-in already available on this Mac."
        case .apiKey:
            return "Uses saved sign-in details on this Mac."
        case .token:
            return "Uses saved sign-in details on this Mac."
        }
    }

    private static func fallbackActiveAccessTitle(providerId: String, probeMode: String?) -> String {
        let providerLabel = switch providerId {
        case "openai-codex":
            "ChatGPT"
        case "openai":
            "OpenAI"
        case "anthropic":
            "Claude"
        default:
            providerId
        }

        switch probeMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "api_key":
            return "\(providerLabel) account"
        case "token":
            return "\(providerLabel) account"
        case "oauth":
            return "\(providerLabel) login"
        default:
            return providerLabel
        }
    }

    private static func gatewayReadinessProbe() async throws -> ConsumerModelsReadinessPayload {
        return try await self.requestDecoded(
            method: "models.readiness",
            timeoutMs: 20_000)
    }

    private static func consumerFriendlyReadinessError(_ error: Error) -> String {
        if error is CancellationError {
            return "\(AppFlavor.current.appName) is still starting. Restart \(AppFlavor.current.appName) if this keeps happening."
        }

        if error is ReadinessProbeTimeoutError {
            return "\(AppFlavor.current.appName) is still checking AI access. Restart \(AppFlavor.current.appName) if this keeps happening."
        }

        let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !detail.isEmpty else {
            return "\(AppFlavor.current.appName) could not check AI access yet. Restart \(AppFlavor.current.appName) if this keeps happening."
        }

        if Self.consumerAccessFailureKind(for: error) == .gatewayUnreachable
        {
            return Self.gatewayRestartFailureStatusLine()
        }

        return detail
    }

    private static func gatewayRestartFailureStatusLine() -> String {
        "\(AppFlavor.current.appName) is still starting. Restart \(AppFlavor.current.appName) if it does not reconnect."
    }

    private static func signInURL(from notes: [String]) -> URL? {
        for note in notes {
            for rawToken in note.split(whereSeparator: { $0.isWhitespace }) {
                let trimmed = rawToken.trimmingCharacters(in: CharacterSet(charactersIn: "<>()[]{}\"'.,"))
                guard
                    trimmed.hasPrefix("https://"),
                    let url = URL(string: trimmed),
                    url.host?.contains("openai.com") == true
                else {
                    continue
                }
                return url
            }
        }
        return nil
    }

    private static func runtimeOwnershipRepairInProgressStatusLine() -> String {
        "Finishing \(AppFlavor.current.appName) update…"
    }

    private static func runtimeOwnershipRepairFailureStatusLine() -> String {
        "\(AppFlavor.current.appName) helper needs repair. Try Restart \(AppFlavor.current.appName)."
    }

    private static func consumerAccessFailureKind(for error: Error) -> ConsumerAIAccessFailureKind {
        if let authError = error as? GatewayConnectAuthError,
           authError.detail == .pairingRequired
        {
            return .gatewayUnreachable
        }
        if let authError = error as? GatewayConnectAuthError,
           authError.detail == .authTokenMismatch || authError.detail == .authDeviceTokenMismatch
        {
            return .gatewayUnreachable
        }

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
            || lowercased.contains("pairing required")
            || lowercased.contains("token_mismatch")
            || lowercased.contains("token mismatch")
            || lowercased.contains("device_token_mismatch")
            || lowercased.contains("device token mismatch")
            || lowercased.contains("socket is not connected")
            || lowercased.contains("timed out")
            || lowercased.contains("timeout")
        {
            return .gatewayUnreachable
        }

        return .readinessFailed
    }

    private static func gatewayAuthOptionsLoader() async throws -> ConsumerModelsAuthListPayload {
        return try await self.requestDecoded(
            method: "models.auth.list",
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
        return try await self.requestDecoded(
            method: "models.auth.apply",
            params: params,
            timeoutMs: 120_000)
    }

    private static func gatewayModelsLoader() async throws -> ConsumerModelsModelListPayload {
        return try await self.requestDecoded(
            method: "models.consumer.list",
            timeoutMs: 20_000)
    }

    private static func gatewayModelApply(modelId: String) async throws -> ConsumerModelsSetPayload {
        return try await self.requestDecoded(
            method: "models.consumer.apply",
            params: ["model": AnyCodable(modelId)],
            timeoutMs: 20_000)
    }

    private static func requestDecoded<T: Decodable>(
        method: String,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> T
    {
        // Main's typed GatewayConnection enum has not yet absorbed the consumer
        // model endpoints. Use the existing raw-string gateway API here so this
        // parity slice stays out of GatewayConnection, which is owned by another
        // lane for this rollout.
        let data = try await GatewayConnection.shared.requestRaw(
            method: method,
            params: params,
            timeoutMs: timeoutMs)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw GatewayDecodingError(method: method, message: error.localizedDescription)
        }
    }
}

private struct ReadinessProbeTimeoutError: LocalizedError, Sendable {
    var errorDescription: String? {
        "\(AppFlavor.current.appName)'s AI access check timed out."
    }
}

private actor RestartGatewayCompletion {
    private var completed = false

    var isCompleted: Bool {
        self.completed
    }

    func markCompleted() {
        self.completed = true
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
    let voiceStatus: String?
    let voiceSummary: String?
    let voiceActions: [String]?
    let probe: ConsumerModelsReadinessProbePayload?

    init(
        status: String,
        defaultModel: String?,
        summary: String,
        reasonCodes: [String],
        mode: String? = nil,
        authMode: String? = nil,
        sharedProfileId: String? = nil,
        voiceStatus: String? = nil,
        voiceSummary: String? = nil,
        voiceActions: [String]? = nil,
        probe: ConsumerModelsReadinessProbePayload? = nil)
    {
        self.status = status
        self.defaultModel = defaultModel
        self.summary = summary
        self.reasonCodes = reasonCodes
        self.mode = mode
        self.authMode = authMode
        self.sharedProfileId = sharedProfileId
        self.voiceStatus = voiceStatus
        self.voiceSummary = voiceSummary
        self.voiceActions = voiceActions
        self.probe = probe
    }

    func consumerReadyStatusLine(modelDisplay: String) -> String {
        let base = "AI ready on \(modelDisplay)."
        let trimmedVoiceSummary = self.voiceSummary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedVoiceSummary.isEmpty else {
            return base
        }
        return "\(base) \(trimmedVoiceSummary)"
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
            return "\(AppFlavor.current.appName)'s AI access is ready."
        }
        // Consumer onboarding needs a plain-English blocker. The gateway already
        // computed the truthful live-probe summary, so surface that instead of
        // re-deriving auth state from stale local snapshots.
        let trimmedSummary = self.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedSummary.isEmpty {
            return self.consumerProductSummary(trimmedSummary)
        }
        switch self.consumerFailureKind {
        case .gatewayUnreachable:
            return "\(AppFlavor.current.appName) is still starting. Restart \(AppFlavor.current.appName) if it does not reconnect."
        case .providerAuthFailed:
            return "\(AppFlavor.current.appName) needs a fresh AI sign-in."
        case .readinessFailed:
            return "\(AppFlavor.current.appName) could not finish an AI test message. Restart \(AppFlavor.current.appName) to reconnect AI access."
        case .runtimeUpdateBlocked:
            return "\(AppFlavor.current.appName) helper needs repair. Try Restart \(AppFlavor.current.appName)."
        }
    }

    private func consumerProductSummary(_ summary: String) -> String {
        let appName = AppFlavor.current.appName
        return summary
            .replacingOccurrences(of: "OpenClaw-managed", with: "\(appName)-managed")
            .replacingOccurrences(of: "OpenClaw's", with: "\(appName)'s")
            .replacingOccurrences(of: "OpenClaw ", with: "\(appName) ")
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

    var consumerProviderLabel: String {
        switch self.providerId {
        case "openai-codex":
            return "ChatGPT"
        case "anthropic":
            return "Claude"
        default:
            let trimmed = self.providerLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? self.providerId : trimmed
        }
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
                return "\(AppFlavor.current.appName) saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."
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
                    return "This Mac is out of disk space, so \(AppFlavor.current.appName) could not finish browser setup. Free some space and try again."
                }
                if ConsumerSetupCommandRunner.isMissingBuildOutputFailure(message) {
                    return "\(AppFlavor.current.appName) could not finish browser setup because the local test runtime is not built. Relaunch the UI smoke app so it can rebuild the browser checker."
                }
                if ConsumerSetupCommandRunner.isTransientBrowserStatusFailure(message) {
                    if nowImpl().addingTimeInterval(1) < deadline {
                        await sleepImpl(retryIntervalNanos)
                        continue
                    }
                    return nil
                }
                // Keep raw command output out of onboarding. The underlying
                // failure can include file paths, stack traces, or runtime
                // internals that do not help a beta user recover.
                return "\(AppFlavor.current.appName) saved the Chrome profile, but could not finish the browser check. Try again in a moment."
            }

            let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let data = stdout.data(using: .utf8),
                  let payload = try? JSONDecoder().decode(ConsumerBrowserStatusPayload.self, from: data)
            else {
                return "\(AppFlavor.current.appName) saved the Chrome profile, but browser readiness returned unreadable output."
            }
            if payload.enabled == false {
                return "Browser control is disabled in config. Re-enable it and try again."
            }
            if let detectError = payload.detectError?.trimmingCharacters(in: .whitespacesAndNewlines),
               !detectError.isEmpty
            {
                return "\(AppFlavor.current.appName) saved the Chrome profile, but could not prepare Chrome on this Mac: \(detectError)"
            }
            if payload.chosenBrowser == nil && payload.detectedBrowser == nil && payload.detectedExecutablePath == nil {
                return "\(AppFlavor.current.appName) saved the Chrome profile, but Chrome still does not look ready on this Mac."
            }
            return nil
        }
    }
}

struct ConsumerModelSetupCardContent: View {
    @Bindable var model: ConsumerModelSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.choiceList()

            if case .checking = self.model.phase {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking sign-in options…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if case let .failed(message) = self.model.phase,
                      self.model.shouldShowReadinessFailureCallout
            {
                self.failureCallout(message: message)
            }

            self.authFeedback()
        }
        .task {
            await self.model.refreshIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await self.model.refreshOnAppActivationIfNeeded() }
        }
    }

    @ViewBuilder
    private func choiceList() -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let option = self.model.chatGPTSubscriptionOption {
                self.choiceButton(
                    title: "Continue with ChatGPT",
                    helper: "Use your ChatGPT subscription.",
                    isSelected: self.model.selectedOptionId == option.id,
                    isDisabled: self.model.isApplyingAuth || self.model.isAuthChoiceInteractionBlocked,
                    badge: nil,
                    showsCheckmark: self.model.isActiveAuthOption(option))
                {
                    self.model.selectOption(option.id)
                    Task { await self.model.submitSelectedAuth() }
                }
            } else {
                self.choiceButton(
                    title: "Continue with ChatGPT",
                    helper: "Use your ChatGPT subscription.",
                    isSelected: false,
                    isDisabled: true,
                    badge: self.model.authOptionsLoaded ? "Unavailable" : nil,
                    showsCheckmark: false,
                    action: {})
            }

            if let option = self.model.claudeSubscriptionOption {
                self.choiceButton(
                    title: "Continue with Claude",
                    helper: "Use your Claude subscription.",
                    isSelected: self.model.selectedOptionId == option.id,
                    isDisabled: self.model.isApplyingAuth || self.model.isAuthChoiceInteractionBlocked,
                    badge: nil,
                    showsCheckmark: self.model.isActiveAuthOption(option))
                {
                    self.model.selectOption(option.id)
                    Task { await self.model.submitSelectedAuth() }
                }
            } else {
                self.choiceButton(
                    title: "Continue with Claude",
                    helper: "Use your Claude subscription.",
                    isSelected: false,
                    isDisabled: true,
                    badge: self.model.authOptionsLoaded ? "Unavailable" : nil,
                    showsCheckmark: false,
                    action: {})
            }

            self.choiceButton(
                title: "API key",
                helper: "Use an API key from OpenAI, Anthropic, or another provider.",
                isSelected: self.model.isAPIKeySelected,
                isDisabled: !self.model.hasAPIKeySupport || self.model.isApplyingAuth || self.model.isAuthChoiceInteractionBlocked,
                badge: self.model.hasAPIKeySupport || !self.model.authOptionsLoaded ? nil : "Coming soon",
                showsCheckmark: self.model.selectedAPIKeyOption.map { self.model.isActiveAuthOption($0) } ?? false)
            {
                self.model.selectAPIKeySetup()
            }

            if self.model.isAPIKeySelected,
               let option = self.model.selectedAPIKeyOption
            {
                self.apiKeyEditor(option: option)
                    .padding(.leading, 2)
            }
        }
    }

    private func choiceButton(
        title: String,
        helper: String?,
        isSelected: Bool,
        isDisabled: Bool,
        badge: String?,
        showsCheckmark: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(isDisabled && !isSelected ? .secondary : .primary)
                    if let helper, !helper.isEmpty {
                        Text(helper)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 12)

                if let badge {
                    Text(badge)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(Color(nsColor: .controlBackgroundColor)))
                }

                if showsCheckmark {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color(nsColor: .systemGreen))
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isSelected ? Color(nsColor: .selectedContentBackgroundColor).opacity(0.10) : Color(nsColor: .controlBackgroundColor)))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color(nsColor: .systemBlue) : Color(nsColor: .separatorColor), lineWidth: isSelected ? 1.2 : 1))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled && !isSelected ? 0.62 : 1)
    }

    @ViewBuilder
    private func apiKeyEditor(option: ConsumerModelsAuthOptionPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.model.apiKeyProviders.count > 1 {
                Picker("Provider", selection: Binding(
                    get: { self.model.selectedAPIKeyProviderId },
                    set: { self.model.selectAPIKeyProvider($0) }))
                {
                    ForEach(self.model.apiKeyProviders) { provider in
                        Text(provider.label)
                            .tag(provider.id)
                    }
                }
                .pickerStyle(.menu)
            }

            Text("API key")
                .font(.caption.weight(.semibold))

            SecureField("Paste your API key", text: self.$model.draftSecret)

            HStack(spacing: 10) {
                Button("Save and check") {
                    Task { await self.model.submitSelectedAuth() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.isApplyingAuth)

                if self.model.isApplyingAuth {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
        .padding(.top, 2)
    }

    @ViewBuilder
    private func modelPickerSection() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Model")
                .font(.subheadline.weight(.semibold))
            Text("Choose the model \(AppFlavor.current.appName) should use.")
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

    @ViewBuilder
    private func failureCallout(message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(self.model.failureKind?.title ?? "AI access needs attention")
                .font(.subheadline.weight(.semibold))
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                if self.model.canRestartOperator {
                    Button {
                        Task { await self.model.restartOperator() }
                    } label: {
                        if self.model.isRestartingOperator {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("Restart \(AppFlavor.current.appName)", systemImage: "arrow.clockwise")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.model.isRestartingOperator)
                }

                if self.model.canChooseAnotherAccessMethod {
                    Button("Choose Another Access Method") {
                        self.model.chooseAnotherAccessMethod()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    @ViewBuilder
    private func authEditor(option: ConsumerModelsAuthOptionPayload, isReady: Bool) -> some View {
        if isReady {
            self.readyAuthEditor(option: option)
        } else {
            self.notReadyAuthEditor(option: option)
        }
    }

    @ViewBuilder
    private func readyAuthEditor(option: ConsumerModelsAuthOptionPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Use a different AI account")
                .font(.subheadline.weight(.semibold))
            Text("Change this only if you want a different sign-in method.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.model.availableAuthCategories.count > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Access type")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.authCategory },
                        set: { self.model.selectAuthCategory($0) }))
                    {
                        ForEach(self.model.availableAuthCategories) { category in
                            Text(category.title)
                                .tag(category)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }

            let providers = self.model.readyAuthProviders
            if !providers.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.model.authCategory == .apiKey ? "Saved key provider" : "Account login")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.preferredProviderId(for: providers, fallback: option.providerId) },
                        set: { self.model.selectProvider($0) }))
                    {
                        ForEach(providers) { provider in
                            Text(provider.label)
                                .tag(provider.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }

            if option.inputKind != .none {
                Text(self.displayTitle(for: option))
                    .font(.caption.weight(.semibold))

                Text(self.displayDetail(for: option))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if self.model.selectedProviderOptions.count > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sign-in method")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.selectedOptionId ?? option.id },
                        set: { self.model.selectOption($0) }))
                    {
                        ForEach(self.model.selectedProviderOptions) { method in
                            Text(self.displayTitle(for: method))
                                .tag(method.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }

            self.authSecretFieldIfNeeded(option: option)
            self.authActionRow(label: option.submitLabel, showsCheckAgain: !option.inputKind.requiresSecret)
            self.authFeedback()
        }
    }

    @ViewBuilder
    private func notReadyAuthEditor(option: ConsumerModelsAuthOptionPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if option.providerId != "openai-codex" || option.inputKind != .none {
                Text(self.primaryAuthTitle(for: option))
                    .font(.subheadline.weight(.semibold))
                if let body = self.primaryAuthBody(for: option) {
                    Text(body)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if option.inputKind.requiresSecret {
                self.advancedAuthControls(option: option)
            }

            self.authSecretFieldIfNeeded(option: option)
            self.authActionRow(
                label: self.primaryAuthButtonLabel(for: option),
                showsCheckAgain: !option.inputKind.requiresSecret)
            self.authFeedback()

            if !option.inputKind.requiresSecret, self.model.showsAdvancedAuthControls {
                DisclosureGroup("Use another sign-in method", isExpanded: self.$model.alternateMethodExpanded) {
                    self.advancedAuthControls(option: option)
                        .padding(.top, 8)
                }
            }
        }
    }

    @ViewBuilder
    private func authSecretFieldIfNeeded(option: ConsumerModelsAuthOptionPayload) -> some View {
        if option.inputKind.requiresSecret {
            VStack(alignment: .leading, spacing: 6) {
                if let inputLabel = self.displayInputLabel(for: option) {
                    Text(inputLabel)
                        .font(.caption.weight(.semibold))
                }
                SecureField(
                    option.inputPlaceholder ?? "",
                    text: self.$model.draftSecret)
                if let inputHelp = self.displayInputHelp(for: option), !inputHelp.isEmpty {
                    Text(inputHelp)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func authActionRow(label: String, showsCheckAgain: Bool = true) -> some View {
        HStack(spacing: 10) {
            Button(label) {
                Task { await self.model.submitSelectedAuth() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.model.isApplyingAuth)

            if self.model.isApplyingAuth {
                ProgressView()
                    .controlSize(.small)
            }

            if showsCheckAgain {
                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .disabled(self.model.isApplyingAuth)
            }
        }
    }

    @ViewBuilder
    private func authFeedback() -> some View {
        if self.model.isWaitingForChatGPTSignIn {
            self.chatGPTSignInStatus()
        } else if let authError = self.model.authError, !authError.isEmpty {
            Text(authError)
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        } else if let note = self.consumerSafeAuthNote, !note.isEmpty {
            Text(note)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func chatGPTSignInStatus() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Opening ChatGPT sign-in in your browser...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if self.model.canShowChatGPTSignInHelp {
                HStack(spacing: 10) {
                    Button("Trouble signing in?") {
                        self.model.signInHelpExpanded.toggle()
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }

                if self.model.signInHelpExpanded {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("If your browser did not open, open the sign-in link.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        if self.model.chatGPTSignInURL != nil {
                            HStack(spacing: 10) {
                                Button("Open sign-in link") {
                                    self.model.openChatGPTSignInLink()
                                }
                                .buttonStyle(.bordered)

                                Button("Copy sign-in link") {
                                    self.model.copyChatGPTSignInLink()
                                }
                                .buttonStyle(.bordered)
                            }

                            Text("Paste it into any browser to continue.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Text("Once you sign in, return to Jarvis.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private var consumerSafeAuthNote: String? {
        guard let note = self.model.authNotes.last?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else {
            return nil
        }
        guard !note.lowercased().hasPrefix("open:") else {
            return nil
        }
        guard URL(string: note) == nil else {
            return nil
        }
        return note
    }

    private func primaryAuthTitle(for option: ConsumerModelsAuthOptionPayload) -> String {
        if option.providerId == "openai-codex", option.inputKind == .none {
            return "Continue with ChatGPT"
        }
        if option.inputKind == .apiKey {
            return "Paste your API key"
        }
        if option.inputKind == .token {
            return "Paste your sign-in code"
        }
        return option.title
    }

    private func primaryAuthBody(for option: ConsumerModelsAuthOptionPayload) -> String? {
        if option.providerId == "openai-codex", option.inputKind == .none {
            return "Use your ChatGPT account for Jarvis tasks."
        }
        if option.inputKind == .apiKey {
            return nil
        }
        return self.displayDetail(for: option)
    }

    private func primaryAuthButtonLabel(for option: ConsumerModelsAuthOptionPayload) -> String {
        if option.providerId == "openai-codex", option.inputKind == .none {
            return "Continue with ChatGPT"
        }
        return option.submitLabel
    }

    private func displayTitle(for option: ConsumerModelsAuthOptionPayload) -> String {
        switch option.inputKind {
        case .none:
            return option.title
        case .apiKey:
            return "Paste your API key"
        case .token:
            return "Paste your sign-in code"
        }
    }

    @ViewBuilder
    private func advancedAuthControls(option: ConsumerModelsAuthOptionPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.model.availableAuthCategories.count > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Access type")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.authCategory },
                        set: { self.model.selectAuthCategory($0) }))
                    {
                        ForEach(self.model.availableAuthCategories) { category in
                            Text(category.title)
                                .tag(category)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }

            let providers = self.model.readyAuthProviders
            if !providers.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.model.authCategory == .apiKey ? "Saved key provider" : "Account login")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.preferredProviderId(for: providers, fallback: option.providerId) },
                        set: { self.model.selectProvider($0) }))
                    {
                        ForEach(providers) { provider in
                            Text(provider.label)
                                .tag(provider.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }

            if self.model.selectedProviderOptions.count > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sign-in method")
                        .font(.caption.weight(.semibold))
                    Picker("", selection: Binding(
                        get: { self.model.selectedOptionId ?? option.id },
                        set: { self.model.selectOption($0) }))
                    {
                        ForEach(self.model.selectedProviderOptions) { method in
                            Text(self.displayTitle(for: method))
                                .tag(method.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }
        }
    }

    private func displayDetail(for option: ConsumerModelsAuthOptionPayload) -> String {
        switch option.inputKind {
        case .none:
            return option.detail
        case .apiKey:
            return "Saved key only."
        case .token:
            return "Sign-in code only."
        }
    }

    private func displayInputLabel(for option: ConsumerModelsAuthOptionPayload) -> String? {
        switch option.inputKind {
        case .none:
            return option.inputLabel
        case .apiKey:
            return "API key"
        case .token:
            return "Sign-in code"
        }
    }

    private func displayInputHelp(for option: ConsumerModelsAuthOptionPayload) -> String? {
        switch option.inputKind {
        case .none:
            return option.inputHelp
        case .apiKey:
            return nil
        case .token:
            return nil
        }
    }
}
