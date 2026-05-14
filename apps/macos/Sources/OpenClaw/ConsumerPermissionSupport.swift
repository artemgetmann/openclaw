import AppKit
import OpenClawIPC
import SwiftUI

enum ConsumerPermissionRecoverySupport {
    struct Context: Equatable {
        var attemptedSettingsRecovery = false
        var requestedExplicitSettingsFollowUp = false
        var reactivatedAfterSettings = false
    }

    enum DisplayState: Equatable {
        case granted
        case notRequested
        case needsSystemSettings
        case checking
        case restartRequired
    }

    struct Presentation {
        let displayState: DisplayState
        let actionLabel: String?
        let statusText: String
        let detailText: String?
        let statusColor: Color?
    }

    struct StepInstruction: Equatable, Identifiable {
        let capability: Capability
        let title: String
        let body: String

        var id: Capability { self.capability }
    }

    // Accessibility and Screen Recording have real macOS recovery phases that a
    // plain Bool cannot represent. Keep that complexity inside the consumer UI.
    static func presentation(
        for capability: Capability,
        granted: Bool,
        isChecking: Bool,
        context: Context?)
        -> Presentation
    {
        if granted {
            return Presentation(
                displayState: .granted,
                actionLabel: nil,
                statusText: "Granted",
                detailText: nil,
                statusColor: .green)
        }

        if isChecking {
            return Presentation(
                displayState: .checking,
                actionLabel: nil,
                statusText: "Checking...",
                detailText: nil,
                statusColor: nil)
        }

        guard self.requiresSettingsRecovery(capability), let context, context.attemptedSettingsRecovery else {
            return Presentation(
                displayState: .notRequested,
                actionLabel: "Grant",
                statusText: self.defaultPendingHint(for: capability),
                detailText: nil,
                statusColor: nil)
        }

        // Only escalate to "Restart app" after the user has explicitly retried the
        // System Settings path from our UI. A passive app reactivation alone is
        // too weak a signal because macOS can land Screen Recording on a blank
        // pane, leaving the user without a real chance to complete the toggle.
        if context.requestedExplicitSettingsFollowUp && context.reactivatedAfterSettings {
            return Presentation(
                displayState: .restartRequired,
                actionLabel: "Restart app",
                statusText: "Enabled already? Restart app",
                detailText: self.restartRecoveryDetail(for: capability),
                statusColor: .orange)
        }

        return Presentation(
            displayState: .needsSystemSettings,
            actionLabel: self.settingsActionLabel(for: capability),
            statusText: self.settingsActionLabel(for: capability),
            detailText: self.systemSettingsDetail(for: capability),
            statusColor: nil)
    }

    @MainActor
    static func recommendedSummary(
        status: [Capability: Bool],
        contexts: [Capability: Context],
        hasAttemptedRecommendedFlow: Bool,
        isChecking: Bool,
        recommendedCapabilities: [Capability] = ConsumerPermissionCatalog.settingsRecommendedCapabilities)
        -> String?
    {
        if isChecking {
            return "Checking the latest permission changes..."
        }

        let unresolvedRecommended = recommendedCapabilities.filter {
            status[$0] != true
        }
        if unresolvedRecommended.isEmpty {
            return "Recommended permissions are ready."
        }

        let specialUnresolved = unresolvedRecommended.filter(self.requiresSettingsRecovery)
        if !specialUnresolved.isEmpty {
            let restartNeeded = specialUnresolved.contains {
                let context = contexts[$0]
                return context?.requestedExplicitSettingsFollowUp == true && context?.reactivatedAfterSettings == true
            }
            if restartNeeded {
                return "If Accessibility or Screen Recording is already enabled in System Settings, reopen the app once so macOS refreshes the status."
            }
            if hasAttemptedRecommendedFlow || specialUnresolved.contains(where: { contexts[$0]?.attemptedSettingsRecovery == true }) {
                return "Accessibility lives in Privacy & Security -> Accessibility. Screen Recording lives in Privacy & Security -> Screen & System Audio Recording."
            }
        }

        if hasAttemptedRecommendedFlow {
            return "\(unresolvedRecommended.count) recommended permission\(unresolvedRecommended.count == 1 ? "" : "s") still need attention."
        }
        return nil
    }

    static func requiresSettingsRecovery(_ capability: Capability) -> Bool {
        capability == .accessibility || capability == .screenRecording
    }

    static func stepInstructions(
        status: [Capability: Bool],
        contexts: [Capability: Context],
        hasAttemptedRecommendedFlow: Bool) -> [StepInstruction]
    {
        let shouldShow = hasAttemptedRecommendedFlow || Self.requiresInstructionCard(status: status, contexts: contexts)
        guard shouldShow else { return [] }

        var instructions: [StepInstruction] = []
        if status[.accessibility] != true {
            instructions.append(
                StepInstruction(
                    capability: .accessibility,
                    title: "Accessibility",
                    body: "macOS can take 10-15 seconds to load Privacy & Security. Keep System Settings open, click Accessibility, then turn on \(AppFlavor.current.appName)."))
        }
        if status[.screenRecording] != true {
            instructions.append(
                StepInstruction(
                    capability: .screenRecording,
                    title: "Screen Recording",
                    body: "In Privacy & Security, wait for the list to load, scroll down, click Screen & System Audio Recording, then turn on \(AppFlavor.current.appName)."))
        }
        return instructions
    }

    private static func requiresInstructionCard(
        status: [Capability: Bool],
        contexts: [Capability: Context]) -> Bool
    {
        [.accessibility, .screenRecording].contains { capability in
            status[capability] != true && contexts[capability]?.attemptedSettingsRecovery == true
        }
    }

    private static func defaultPendingHint(for capability: Capability) -> String {
        switch capability {
        case .accessibility, .screenRecording:
            return "Grant access"
        default:
            return "Request access"
        }
    }

    private static func systemSettingsDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            return "macOS can take 10-15 seconds to load Privacy & Security. Keep System Settings open, click Accessibility, then enable this app."
        case .screenRecording:
            return "Privacy & Security can take a moment to load. Wait for the list, click Screen & System Audio Recording, then enable this app."
        default:
            return nil
        }
    }

    private static func settingsActionLabel(for capability: Capability) -> String {
        switch capability {
        case .accessibility, .screenRecording:
            return "Open Privacy & Security"
        default:
            return "Open Settings"
        }
    }

    private static func restartRecoveryDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            return "If Privacy & Security is still loading, keep System Settings open for 10-15 seconds, click Accessibility, and confirm this app is enabled. If it already is, reopen the app once."
        case .screenRecording:
            return "If Privacy & Security is still loading, wait for the list, click Screen & System Audio Recording, and confirm this app is enabled. If it already is, reopen the app once."
        default:
            return nil
        }
    }
}

enum ConsumerPermissionCatalog {
    // These are the permissions that can strand a remote-first consumer user if
    // we leave them for later. Keep the onboarding set intentionally small.
    static let coreCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
        .appleScript,
        .location,
    ]

    // Keep Location visible during first run, but do not let flaky refresh state
    // block the rest of onboarding while we validate the higher-leverage remote
    // control path. The user can still grant it here or recover it later.
    static let recommendedOnboardingCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
        .appleScript,
        .location,
    ]

    static let settingsRecommendedCapabilities: [Capability] = [
        .screenRecording,
        .accessibility,
        .appleScript,
        .location,
    ]

    // One CTA should request everything macOS will allow directly, then leave
    // unresolved rows behind for the Settings-driven recovery path.
    static let coreRequestOrder: [Capability] = [
        .appleScript,
        .location,
        .screenRecording,
        .accessibility,
    ]

    static func shouldPauseCoreRequestFlow(after capability: Capability, granted: Bool) -> Bool {
        // Accessibility and Screen Recording can throw the user into a macOS-owned
        // prompt or Settings pane. Chaining the next special permission immediately
        // after that is unreliable: the app loses focus, the next request can get
        // skipped, and TCC can register the wrong/stale row. Stop after the first
        // unresolved special permission and let the user finish that system flow
        // before we ask for the next one.
        ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) && !granted
    }

    static let settingsBulkGrantCapabilities: [Capability] = [
        .appleScript,
        .location,
    ]

    static let optionalCapabilities: [Capability] = [
        .notifications,
        .microphone,
        .camera,
        .speechRecognition,
    ]

    static func openSettings(for capability: Capability) {
        switch capability {
        case .accessibility:
            AccessibilityPermissionHelper.openSettings()
        case .screenRecording:
            ScreenRecordingPermissionHelper.openSettings()
        case .microphone:
            MicrophonePermissionHelper.openSettings()
        case .camera:
            CameraPermissionHelper.openSettings()
        case .location:
            LocationPermissionHelper.openSettings()
        case .notifications:
            NotificationPermissionHelper.openSettings()
        case .appleScript:
            Task { @MainActor in
                await AppleScriptPermission.requestAuthorization()
            }
        case .speechRecognition:
            break
        }
    }
}

struct ConsumerCorePermissionsSection: View {
    enum Presentation {
        case onboarding
        case settings
    }

    let status: [Capability: Bool]
    let refresh: () async -> Void
    let presentation: Presentation

    @State private var requestingCorePermissions = false
    @State private var pendingCapability: Capability?
    @State private var hasAttemptedCoreFlow = false
    @State private var recoveryContexts: [Capability: ConsumerPermissionRecoverySupport.Context] = [:]

    private var isCompact: Bool {
        self.presentation == .onboarding
    }

    private var isComplete: Bool {
        ConsumerPermissionCatalog.coreCapabilities.allSatisfy { self.status[$0] == true }
    }

    private var needsSpecialRecoveryHelp: Bool {
        ConsumerPermissionCatalog.coreCapabilities.contains { capability in
            guard ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) else { return false }
            let state = self.presentation(for: capability).displayState
            return state == .needsSystemSettings || state == .restartRequired
        }
    }

    private var recoverySummary: String? {
        ConsumerPermissionRecoverySupport.recommendedSummary(
            status: self.status,
            contexts: self.recoveryContexts,
            hasAttemptedRecommendedFlow: self.hasAttemptedCoreFlow,
            isChecking: self.requestingCorePermissions,
            recommendedCapabilities: ConsumerPermissionCatalog.recommendedOnboardingCapabilities)
    }

    private var recoveryInstructions: [ConsumerPermissionRecoverySupport.StepInstruction] {
        ConsumerPermissionRecoverySupport.stepInstructions(
            status: self.status,
            contexts: self.recoveryContexts,
            hasAttemptedRecommendedFlow: self.hasAttemptedCoreFlow)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            self.actions
            self.summary
            self.instructions
            self.restartRecovery
            self.permissionRows
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            self.markReactivated()
            Task { await self.refreshStatusTransitions() }
        }
        .onChange(of: self.status) { _, newValue in
            self.reconcileContexts(using: newValue)
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Task { await self.grantCorePermissions() }
            } label: {
                Label(
                    self.requestingCorePermissions ? "Requesting core permissions..." : "Grant core permissions",
                    systemImage: self.requestingCorePermissions ? "hourglass" : "lock.shield")
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.requestingCorePermissions)

            Button {
                Task { await self.refreshStatusTransitions() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(self.requestingCorePermissions)
        }
    }

    @ViewBuilder
    private var summary: some View {
        if let recoverySummary {
            Text(recoverySummary)
                .font(.footnote.weight(.medium))
                .foregroundStyle(self.needsSpecialRecoveryHelp ? .orange : .secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var instructions: some View {
        if !self.recoveryInstructions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("What to click in macOS")
                    .font(.footnote.weight(.semibold))
                ForEach(self.recoveryInstructions) { instruction in
                    self.instructionRow(instruction)
                }
            }
            .padding(12)
            .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func instructionRow(_ instruction: ConsumerPermissionRecoverySupport.StepInstruction) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(instruction.title)
                .font(.footnote.weight(.semibold))
            Text(instruction.body)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var restartRecovery: some View {
        if self.needsSpecialRecoveryHelp {
            VStack(alignment: .leading, spacing: 8) {
                Text("If Accessibility or Screen Recording still looks pending after you enabled it in System Settings, reopen \(AppFlavor.current.appName) once. macOS can leave those statuses stale until the app starts again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    DebugActions.restartApp()
                } label: {
                    Label("Restart \(AppFlavor.current.appName)", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.requestingCorePermissions)
            }
        }
    }

    private var permissionRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(ConsumerPermissionCatalog.recommendedOnboardingCapabilities, id: \.self) { capability in
                self.permissionRow(for: capability)
            }
        }
    }

    private func permissionRow(for capability: Capability) -> some View {
        let rowPresentation = self.presentation(for: capability)
        let isPending = self.pendingCapability == capability ||
            (self.requestingCorePermissions && rowPresentation.displayState == .checking)

        return PermissionRow(
            capability: capability,
            status: rowPresentation.displayState == .granted,
            isPending: isPending,
            compact: self.isCompact,
            actionLabel: rowPresentation.actionLabel,
            statusText: rowPresentation.statusText,
            detailText: rowPresentation.detailText,
            statusColor: rowPresentation.statusColor)
        {
            Task { await self.handle(capability, rowPresentation: rowPresentation) }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.presentation == .onboarding ? "Core Mac permissions" : "Core permissions")
                .font(.headline)
            Text(
                self.presentation == .onboarding
                    ? "Grant these now so the first real task does not fail later when \(AppFlavor.current.appName) needs to control apps, capture the screen, or use your location."
                    : "If macOS loses track of one of the core permissions later, recover it here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func presentation(for capability: Capability) -> ConsumerPermissionRecoverySupport.Presentation {
        if ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) {
            return ConsumerPermissionRecoverySupport.presentation(
                for: capability,
                granted: self.status[capability] == true,
                isChecking: self.requestingCorePermissions && self.pendingCapability == nil,
                context: self.recoveryContexts[capability])
        }

        if self.status[capability] == true {
            return .init(
                displayState: .granted,
                actionLabel: nil,
                statusText: "Granted",
                detailText: nil,
                statusColor: .green)
        }

        return .init(
            displayState: .notRequested,
            actionLabel: "Grant",
            statusText: "Grant access",
            detailText: self.genericDetailText(for: capability),
            statusColor: nil)
    }

    private func genericDetailText(for capability: Capability) -> String? {
        switch capability {
        case .appleScript:
            return "macOS will ask the first time \(AppFlavor.current.appName) tries to control another app."
        case .location:
            return "Needed for requests like 'find a cafe near me' so the agent can use this Mac's location."
        default:
            return nil
        }
    }

    @MainActor
    private func grantCorePermissions() async {
        guard !self.requestingCorePermissions else { return }
        self.requestingCorePermissions = true
        self.hasAttemptedCoreFlow = true
        defer { self.requestingCorePermissions = false }

        var results: [Capability: Bool] = [:]
        for capability in ConsumerPermissionCatalog.coreRequestOrder {
            let result = await PermissionManager.ensure([capability], interactive: true)[capability] == true
            results[capability] = result
            if ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: capability, granted: result) {
                break
            }
        }

        self.registerRecoveryAttempts(from: results, capabilities: ConsumerPermissionCatalog.recommendedOnboardingCapabilities)
        await self.refreshStatusTransitions()
    }

    @MainActor
    private func handle(
        _ capability: Capability,
        rowPresentation: ConsumerPermissionRecoverySupport.Presentation) async
    {
        guard self.pendingCapability == nil else { return }
        self.hasAttemptedCoreFlow = true

        if ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) {
            switch rowPresentation.displayState {
            case .granted, .checking:
                return
            case .restartRequired:
                DebugActions.restartApp()
                return
            case .needsSystemSettings:
                var context = self.recoveryContexts[capability] ?? .init()
                context.attemptedSettingsRecovery = true
                context.requestedExplicitSettingsFollowUp = true
                context.reactivatedAfterSettings = false
                self.recoveryContexts[capability] = context
                ConsumerPermissionCatalog.openSettings(for: capability)
                return
            case .notRequested:
                break
            }
        }

        self.pendingCapability = capability
        defer { self.pendingCapability = nil }

        let results = await PermissionManager.ensure([capability], interactive: true)
        self.registerRecoveryAttempts(from: results, capabilities: [capability])
        await self.refreshStatusTransitions()
    }

    private func registerRecoveryAttempts(
        from results: [Capability: Bool],
        capabilities: [Capability])
    {
        for capability in capabilities where ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) {
            if results[capability] == true {
                self.recoveryContexts.removeValue(forKey: capability)
                continue
            }
            self.recoveryContexts[capability] = .init(
                attemptedSettingsRecovery: true,
                reactivatedAfterSettings: false)
        }
    }

    private func markReactivated() {
        for capability in ConsumerPermissionCatalog.recommendedOnboardingCapabilities
        where ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability)
        {
            guard var context = self.recoveryContexts[capability], context.attemptedSettingsRecovery else { continue }
            context.reactivatedAfterSettings = true
            self.recoveryContexts[capability] = context
        }
    }

    private func reconcileContexts(using status: [Capability: Bool]) {
        for capability in ConsumerPermissionCatalog.recommendedOnboardingCapabilities
        where ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability)
        {
            if status[capability] == true {
                self.recoveryContexts.removeValue(forKey: capability)
            }
        }
    }

    @MainActor
    private func refreshStatusTransitions() async {
        await self.refresh()

        // macOS permission state often settles after the prompt closes or after
        // the app becomes active again from System Settings.
        for delay in [300_000_000, 900_000_000, 1_800_000_000] {
            try? await Task.sleep(nanoseconds: UInt64(delay))
            await self.refresh()
        }
    }
}
