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

        var id: Capability {
            self.capability
        }
    }

    /// Accessibility and Screen Recording have real macOS recovery phases that a
    /// plain Bool cannot represent. Keep that complexity inside the consumer UI.
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
                statusText: self.pendingStatusText(for: capability),
                detailText: nil,
                statusColor: nil)
        }

        return Presentation(
            displayState: .needsSystemSettings,
            actionLabel: self.settingsActionLabel(for: capability),
            statusText: "Needs approval",
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
                return self.needsRestartRecovery(
                    for: $0,
                    granted: status[$0] == true,
                    context: context)
            }
            if restartNeeded {
                return "If Screen Recording is already enabled in System Settings, reopen the app once so macOS refreshes the status."
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

    static func needsRestartRecovery(
        for capability: Capability,
        granted: Bool,
        context: Context?)
        -> Bool
    {
        guard capability == .screenRecording, !granted, let context else { return false }
        return context.requestedExplicitSettingsFollowUp && context.reactivatedAfterSettings
    }

    static func explicitSettingsFollowUpContext(from context: Context?) -> Context {
        var updated = context ?? .init()
        updated.attemptedSettingsRecovery = true
        updated.requestedExplicitSettingsFollowUp = true
        updated.reactivatedAfterSettings = false
        return updated
    }

    private static func pendingStatusText(for capability: Capability) -> String {
        switch capability {
        default:
            "Not allowed yet"
        }
    }

    private static func systemSettingsDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            "Turn on \(AppFlavor.current.appName) in Privacy & Security -> Accessibility."
        case .screenRecording:
            "Turn on \(AppFlavor.current.appName) in Screen & System Audio Recording."
        default:
            nil
        }
    }

    private static func settingsActionLabel(for capability: Capability) -> String {
        switch capability {
        case .accessibility, .screenRecording:
            "Help"
        default:
            "Open Settings"
        }
    }

    private static func restartRecoveryDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            "If \(AppFlavor.current.appName) is already enabled in Accessibility, reopen the app once."
        case .screenRecording:
            "If \(AppFlavor.current.appName) is already enabled in Screen & System Audio Recording, reopen the app once."
        default:
            nil
        }
    }
}

enum ConsumerPermissionCatalog {
    /// These are the permissions that can strand a remote-first consumer user if
    /// we leave them for later. Keep the onboarding set intentionally small.
    static let coreCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
    ]

    /// Keep Location visible during first run, but do not let flaky refresh state
    /// block the rest of onboarding while we validate the higher-leverage remote
    /// control path. The user can still grant it here or recover it later.
    static let recommendedOnboardingCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
        .location,
    ]

    static let settingsRecommendedCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
        .location,
    ]

    static let settingsBulkGrantCapabilities: [Capability] = [
        .appleScript,
        .location,
    ]

    static let optionalCapabilities: [Capability] = [
        .appleScript,
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

    @State private var pendingCapability: Capability?
    @State private var hasAttemptedCoreFlow = false
    @State private var recoveryContexts: [Capability: ConsumerPermissionRecoverySupport.Context] = [:]
    // This controller owns an AppKit accessory panel rather than a SwiftUI
    // sheet: the drag target needs to live next to System Settings, not above
    // Jarvis's onboarding window.
    @State private var recoveryAccessoryPanel = ConsumerPermissionAccessoryPanelController()

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

    private var needsRestartRecovery: Bool {
        ConsumerPermissionCatalog.coreCapabilities.contains { capability in
            ConsumerPermissionRecoverySupport.needsRestartRecovery(
                for: capability,
                granted: self.status[capability] == true,
                context: self.recoveryContexts[capability])
        }
    }

    private var recoverySummary: String? {
        ConsumerPermissionRecoverySupport.recommendedSummary(
            status: self.status,
            contexts: self.recoveryContexts,
            hasAttemptedRecommendedFlow: self.hasAttemptedCoreFlow,
            isChecking: self.pendingCapability != nil,
            recommendedCapabilities: ConsumerPermissionCatalog.recommendedOnboardingCapabilities)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            self.actions
            self.summary
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
        .onDisappear {
            // The onboarding flow may be replaced before permission status
            // refreshes. Never leave a floating helper panel behind.
            self.recoveryAccessoryPanel.hide()
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            if self.presentation == .settings {
                Button {
                    Task { await self.refreshStatusTransitions() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.pendingCapability != nil)
            }
        }
    }

    @ViewBuilder
    private var summary: some View {
        if self.presentation == .settings, let recoverySummary {
            Text(recoverySummary)
                .font(.footnote.weight(.medium))
                .foregroundStyle(self.needsSpecialRecoveryHelp ? .orange : .secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var restartRecovery: some View {
        if self.needsRestartRecovery {
            VStack(alignment: .leading, spacing: 8) {
                Text("Screen Recording still doesn't look granted.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("After you enabled it in System Settings, click Restart \(AppFlavor.current.appName).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    DebugActions.restartApp()
                } label: {
                    Label("Restart \(AppFlavor.current.appName)", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.pendingCapability != nil)
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
        let isPending = self.pendingCapability == capability

        return PermissionRow(
            capability: capability,
            status: rowPresentation.displayState == .granted,
            isPending: isPending,
            compact: self.isCompact,
            actionLabel: self.actionLabel(for: capability, presentation: rowPresentation),
            statusText: rowPresentation.statusText,
            titleOverride: self.titleOverride(for: capability),
            subtitleOverride: self.subtitleOverride(for: capability),
            detailText: self.detailText(for: capability, presentation: rowPresentation),
            statusColor: rowPresentation.statusColor)
        {
            Task { await self.handle(capability, rowPresentation: rowPresentation) }
        }
    }

    private func actionLabel(
        for capability: Capability,
        presentation rowPresentation: ConsumerPermissionRecoverySupport.Presentation) -> String?
    {
        guard self.presentation == .onboarding,
              ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability),
              rowPresentation.displayState == .needsSystemSettings
        else {
            return rowPresentation.actionLabel
        }
        return "Grant"
    }

    @ViewBuilder
    private var header: some View {
        if self.presentation == .settings {
            VStack(alignment: .leading, spacing: 4) {
                Text("Core permissions")
                    .font(.headline)
                Text("If macOS loses track of one of the core permissions later, recover it here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func presentation(for capability: Capability) -> ConsumerPermissionRecoverySupport.Presentation {
        if ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) {
            return ConsumerPermissionRecoverySupport.presentation(
                for: capability,
                granted: self.status[capability] == true,
                isChecking: false,
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
            statusText: "Not allowed yet",
            detailText: self.genericDetailText(for: capability),
            statusColor: nil)
    }

    private func genericDetailText(for capability: Capability) -> String? {
        switch capability {
        case .appleScript:
            "macOS will ask the first time \(AppFlavor.current.appName) tries to control another app."
        default:
            nil
        }
    }

    private func detailText(
        for capability: Capability,
        presentation rowPresentation: ConsumerPermissionRecoverySupport.Presentation) -> String?
    {
        if self.presentation == .onboarding,
           ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability)
        {
            return nil
        }
        return rowPresentation.detailText
    }

    private func titleOverride(for capability: Capability) -> String? {
        if self.presentation == .onboarding, capability == .location {
            return "Location"
        }
        return nil
    }

    private func subtitleOverride(for capability: Capability) -> String? {
        guard self.presentation == .onboarding else { return nil }
        switch capability {
        case .location:
            return "Use this Mac's location for requests like finding a hotel near me"
        default:
            return nil
        }
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
            case .notRequested, .needsSystemSettings:
                // macOS's Accessibility prompt has a second, redundant path
                // after its first appearance. The panel is designed for the
                // reliable path the user can complete: the exact privacy list.
                // Do not call PermissionManager here; it would trigger the
                // native prompt and then immediately send the user to the same
                // pane, competing with the drag-and-drop instruction.
                self.markExplicitSettingsFollowUp(for: capability)
                self.showRecoveryHelp(for: capability)
                return
            }
        }

        self.pendingCapability = capability
        defer { self.pendingCapability = nil }

        let results = await PermissionManager.ensure([capability], interactive: true)
        self.registerRecoveryAttempts(from: results, capabilities: [capability])
        await self.refreshStatusTransitions()
    }

    private func markExplicitSettingsFollowUp(for capability: Capability) {
        self.recoveryContexts[capability] = ConsumerPermissionRecoverySupport.explicitSettingsFollowUpContext(
            from: self.recoveryContexts[capability])
    }

    private func showRecoveryHelp(for capability: Capability) {
        // Opening the exact pane first gives System Settings time to become
        // frontmost. The controller polls for its live window and only then
        // shows the panel directly above that window.
        ConsumerPermissionCatalog.openSettings(for: capability)
        self.recoveryAccessoryPanel.show(for: capability)
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
                self.recoveryAccessoryPanel.hide(for: capability)
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
