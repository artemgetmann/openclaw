import AppKit
import OpenClawIPC
import SwiftUI

enum ConsumerPermissionRecoverySupport {
    enum RecoverySheet: Identifiable {
        case accessibility
        case screenRecording

        init?(capability: Capability) {
            switch capability {
            case .accessibility:
                self = .accessibility
            case .screenRecording:
                self = .screenRecording
            default:
                return nil
            }
        }

        var id: Capability { self.capability }

        var capability: Capability {
            switch self {
            case .accessibility:
                return .accessibility
            case .screenRecording:
                return .screenRecording
            }
        }
    }

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
            return "Not allowed yet"
        }
    }

    private static func systemSettingsDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            return "Turn on \(AppFlavor.current.appName) in Privacy & Security -> Accessibility."
        case .screenRecording:
            return "Turn on \(AppFlavor.current.appName) in Screen & System Audio Recording."
        default:
            return nil
        }
    }

    private static func settingsActionLabel(for capability: Capability) -> String {
        switch capability {
        case .accessibility, .screenRecording:
            return "Help"
        default:
            return "Open Settings"
        }
    }

    private static func restartRecoveryDetail(for capability: Capability) -> String? {
        switch capability {
        case .accessibility:
            return "If \(AppFlavor.current.appName) is already enabled in Accessibility, reopen the app once."
        case .screenRecording:
            return "If \(AppFlavor.current.appName) is already enabled in Screen & System Audio Recording, reopen the app once."
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
    ]

    // Keep Location visible during first run, but do not let flaky refresh state
    // block the rest of onboarding while we validate the higher-leverage remote
    // control path. The user can still grant it here or recover it later.
    static let recommendedOnboardingCapabilities: [Capability] = [
        .accessibility,
        .screenRecording,
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
    @State private var recoverySheet: ConsumerPermissionRecoverySupport.RecoverySheet?

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
            isChecking: self.requestingCorePermissions,
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
        .sheet(item: self.$recoverySheet) { sheet in
            PermissionOnboardingRecoverySheet(capability: sheet.capability) {
                ConsumerPermissionCatalog.openSettings(for: sheet.capability)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Task { await self.grantCorePermissions() }
            } label: {
                Label(
                    self.requestingCorePermissions ? "Requesting access..." : "Grant Mac Access",
                    systemImage: self.requestingCorePermissions ? "hourglass" : "lock.shield")
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.requestingCorePermissions)

            if self.presentation == .settings {
                Button {
                    Task { await self.refreshStatusTransitions() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(self.requestingCorePermissions)
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
            statusText: "Not allowed yet",
            detailText: self.genericDetailText(for: capability),
            statusColor: nil)
    }

    private func genericDetailText(for capability: Capability) -> String? {
        switch capability {
        case .appleScript:
            return "macOS will ask the first time \(AppFlavor.current.appName) tries to control another app."
        default:
            return nil
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
        if self.presentation == .onboarding {
            self.presentFirstRecoverySheet(from: results)
        }
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
                self.markExplicitSettingsFollowUp(for: capability)
                if self.presentation == .onboarding,
                   let sheet = ConsumerPermissionRecoverySupport.RecoverySheet(capability: capability)
                {
                    self.recoverySheet = sheet
                    return
                }
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
        if self.presentation == .onboarding,
           results[capability] != true,
           let sheet = ConsumerPermissionRecoverySupport.RecoverySheet(capability: capability)
        {
            self.recoverySheet = sheet
        }
        await self.refreshStatusTransitions()
    }

    private func markExplicitSettingsFollowUp(for capability: Capability) {
        self.recoveryContexts[capability] = ConsumerPermissionRecoverySupport.explicitSettingsFollowUpContext(
            from: self.recoveryContexts[capability])
    }

    private func presentFirstRecoverySheet(from results: [Capability: Bool]) {
        for capability in ConsumerPermissionCatalog.coreRequestOrder
        where results[capability] == false
        {
            guard let sheet = ConsumerPermissionRecoverySupport.RecoverySheet(capability: capability) else { continue }
            self.markExplicitSettingsFollowUp(for: capability)
            self.recoverySheet = sheet
            return
        }
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

private struct PermissionOnboardingRecoverySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var didOpenSettings = false

    let capability: Capability
    let openSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(self.title)
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)

                Spacer()

                Button {
                    self.dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.plain)
                .help("Close")
            }

            Text(self.bodyText)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if self.capability == .accessibility || self.capability == .screenRecording {
                HStack(spacing: 12) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .onDrag {
                            NSItemProvider(object: Bundle.main.bundleURL as NSURL)
                        }
                        .help("Drag \(AppFlavor.current.appName) into System Settings")

                    Text("If \(AppFlavor.current.appName) is missing, drag this icon into the list, or click the plus button at the bottom and choose the app.")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                Spacer()

                Button(self.buttonTitle) {
                    self.openSettings()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width: 480)
        .task {
            guard !self.didOpenSettings else { return }
            self.didOpenSettings = true
            self.openSettings()
        }
    }

    private var title: String {
        switch self.capability {
        case .accessibility:
            return "Allow Accessibility to use \(AppFlavor.current.appName)"
        case .screenRecording:
            return "Allow Screen Recording to use \(AppFlavor.current.appName)"
        default:
            return "Allow \(AppFlavor.current.appName)"
        }
    }

    private var bodyText: String {
        switch self.capability {
        case .accessibility:
            return "Open System Settings -> Privacy & Security -> Accessibility and turn on \(AppFlavor.current.appName)."
        case .screenRecording:
            return "Open System Settings -> Privacy & Security -> Screen & System Audio Recording and turn on \(AppFlavor.current.appName)."
        default:
            return "Open System Settings and turn on \(AppFlavor.current.appName)."
        }
    }

    private var buttonTitle: String {
        switch self.capability {
        case .screenRecording:
            return "Open Screen Recording Settings"
        default:
            return "Open System Settings"
        }
    }
}
