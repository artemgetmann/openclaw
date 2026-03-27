import AppKit
import OpenClawIPC
import SwiftUI

enum ConsumerPermissionCatalog {
    // These are the permissions that can strand a remote-first consumer user if
    // we leave them for later. Keep the onboarding set intentionally small.
    static let coreCapabilities: [Capability] = [
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
        .notifications,
        .microphone,
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
        .notifications,
        .appleScript,
        .microphone,
        .location,
    ]

    static let optionalCapabilities: [Capability] = [
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
            recommendedCapabilities: ConsumerPermissionCatalog.coreCapabilities)
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

            HStack(spacing: 10) {
                Button {
                    Task { await self.grantCorePermissions() }
                } label: {
                    if self.requestingCorePermissions {
                        Label("Requesting core permissions…", systemImage: "hourglass")
                    } else {
                        Label("Grant core permissions", systemImage: "lock.shield")
                    }
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

            if let recoverySummary {
                Text(recoverySummary)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(self.needsSpecialRecoveryHelp ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !self.recoveryInstructions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("What to click in macOS")
                        .font(.footnote.weight(.semibold))
                    ForEach(self.recoveryInstructions) { instruction in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(instruction.title)
                                .font(.footnote.weight(.semibold))
                            Text(instruction.body)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(12)
                .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }

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

            VStack(alignment: .leading, spacing: 8) {
                ForEach(ConsumerPermissionCatalog.coreCapabilities, id: \.self) { capability in
                    let rowPresentation = self.presentation(for: capability)
                    PermissionRow(
                        capability: capability,
                        status: rowPresentation.displayState == .granted,
                        isPending: self.pendingCapability == capability ||
                            (self.requestingCorePermissions && rowPresentation.displayState == .checking),
                        compact: self.isCompact,
                        actionLabel: rowPresentation.actionLabel,
                        statusText: rowPresentation.statusText,
                        detailText: rowPresentation.detailText,
                        statusColor: rowPresentation.statusColor)
                    {
                        Task { await self.handle(capability, rowPresentation: rowPresentation) }
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            self.markReactivated()
            Task { await self.refreshStatusTransitions() }
        }
        .onChange(of: self.status) { _, newValue in
            self.reconcileContexts(using: newValue)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.presentation == .onboarding ? "Core Mac permissions" : "Core permissions")
                .font(.headline)
            Text(
                self.presentation == .onboarding
                    ? "Grant these now so the first real task does not fail later when OpenClaw needs to control apps, capture the screen, or use your location."
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
            return "macOS will ask the first time OpenClaw tries to control another app."
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

        self.registerRecoveryAttempts(from: results, capabilities: ConsumerPermissionCatalog.coreCapabilities)
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
        for capability in ConsumerPermissionCatalog.coreCapabilities
        where ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability)
        {
            guard var context = self.recoveryContexts[capability], context.attemptedSettingsRecovery else { continue }
            context.reactivatedAfterSettings = true
            self.recoveryContexts[capability] = context
        }
    }

    private func reconcileContexts(using status: [Capability: Bool]) {
        for capability in ConsumerPermissionCatalog.coreCapabilities
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
