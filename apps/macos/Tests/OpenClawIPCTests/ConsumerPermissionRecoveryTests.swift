import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerPermissionRecoveryTests {
    @Test func `special permission starts as regular grant before recovery attempt`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: false,
            isChecking: false,
            context: nil)

        #expect(presentation.displayState == .notRequested)
        #expect(presentation.actionLabel == "Grant")
        #expect(presentation.statusText == "Grant access")
        #expect(presentation.detailText == nil)
    }

    @Test func `special permission directs user to system settings after failed attempt`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.displayState == .needsSystemSettings)
        #expect(presentation.actionLabel == "Open Privacy & Security")
        #expect(presentation.statusText == "Open Privacy & Security")
        #expect(presentation.detailText?.contains("Screen & System Audio Recording") == true)
        #expect(presentation.detailText?.contains("Wait for the list") == true)
        #expect(presentation.detailText?.contains("older build") == true)
        #expect(presentation.detailText?.contains("Reopen the app and retry") == true)
    }

    @Test func `special permission offers restart after app reactivation`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: false,
            isChecking: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))

        #expect(presentation.displayState == .restartRequired)
        #expect(presentation.actionLabel == "Restart app")
        #expect(presentation.statusText == "Enabled already? Restart app")
        #expect(presentation.detailText?.contains("click Accessibility") == true)
        #expect(presentation.detailText?.contains("10-15 seconds") == true)
    }

    @Test func `special permission stays on open settings after passive reactivation`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: false,
                reactivatedAfterSettings: true))

        #expect(presentation.displayState == .needsSystemSettings)
        #expect(presentation.actionLabel == "Open Privacy & Security")
        #expect(presentation.statusText == "Open Privacy & Security")
    }

    @Test func `screen recording restart copy calls out stale generic row`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))

        #expect(presentation.displayState == .restartRequired)
        #expect(presentation.actionLabel == "Restart app")
        #expect(presentation.detailText?.contains("generic OpenClaw Consumer row") == true)
        #expect(presentation.detailText?.contains("older build") == true)
        #expect(presentation.detailText?.contains("Reopen the app and retry") == true)
    }

    @Test func `accessibility recovery detail explains exactly what to click`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.actionLabel == "Open Privacy & Security")
        #expect(presentation.detailText?.contains("click Accessibility") == true)
        #expect(presentation.detailText?.contains("10-15 seconds") == true)
        #expect(presentation.detailText?.contains("enable this app") == true)
    }

    @Test func `granted permission wins over stale recovery context`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: true,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: true))

        #expect(presentation.displayState == .granted)
        #expect(presentation.actionLabel == nil)
        #expect(presentation.statusText == "Granted")
    }

    @Test func `recommended summary points to system settings after attempted flow`() {
        let summary = ConsumerPermissionRecoverySupport.recommendedSummary(
            status: [
                .screenRecording: false,
                .accessibility: false,
                .notifications: true,
                .appleScript: true,
                .microphone: true,
                .location: true,
            ],
            contexts: [
                .screenRecording: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false),
            ],
            hasAttemptedRecommendedFlow: true,
            isChecking: false)

        #expect(summary?.contains("Screen & System Audio Recording") == true)
        #expect(summary?.contains("Accessibility") == true)
    }

    @Test func `recommended summary points to restart after reactivation`() {
        let summary = ConsumerPermissionRecoverySupport.recommendedSummary(
            status: [
                .screenRecording: false,
                .accessibility: true,
                .notifications: true,
                .appleScript: true,
                .microphone: true,
                .location: true,
            ],
            contexts: [
                .screenRecording: .init(
                    attemptedSettingsRecovery: true,
                    requestedExplicitSettingsFollowUp: true,
                    reactivatedAfterSettings: true),
            ],
            hasAttemptedRecommendedFlow: true,
            isChecking: false)

        #expect(summary?.contains("reopen the app once") == true)
    }

    @Test func `screen recording detail explains blank system settings fallback`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.detailText?.contains("Privacy & Security") == true)
        #expect(presentation.detailText?.contains("enable this app") == true)
    }

    @Test func `instruction card lists both macos click paths after attempted flow`() {
        let instructions = ConsumerPermissionRecoverySupport.stepInstructions(
            status: [
                .screenRecording: false,
                .accessibility: false,
            ],
            contexts: [
                .screenRecording: .init(attemptedSettingsRecovery: true),
                .accessibility: .init(attemptedSettingsRecovery: true),
            ],
            hasAttemptedRecommendedFlow: true)

        #expect(instructions.count == 2)
        #expect(instructions[0].body.contains("10-15 seconds") == true)
        #expect(instructions[0].body.contains("click Accessibility") == true)
        #expect(instructions[1].body.contains("click Screen & System Audio Recording") == true)
    }

    @Test func `bulk grant excludes manual privacy permissions`() {
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.screenRecording))
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.accessibility))
        #expect(PermissionsSettings.consumerBulkGrantCapabilities.contains(.notifications))
        #expect(PermissionsSettings.consumerBulkGrantCapabilities.contains(.location))
    }

    @Test func `core onboarding permissions include apple script and location`() {
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.accessibility))
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.screenRecording))
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.appleScript))
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.location))
    }

    @Test func `core request order asks for screen recording before accessibility`() {
        let screenIndex = ConsumerPermissionCatalog.coreRequestOrder.firstIndex(of: .screenRecording)
        let accessibilityIndex = ConsumerPermissionCatalog.coreRequestOrder.firstIndex(of: .accessibility)

        #expect(screenIndex != nil)
        #expect(accessibilityIndex != nil)
        #expect(screenIndex! < accessibilityIndex!)
    }

    @Test func `core request flow pauses after unresolved special permission`() {
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .appleScript, granted: false))
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .location, granted: false))
        #expect(ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .screenRecording, granted: false))
        #expect(ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .accessibility, granted: false))
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .screenRecording, granted: true))
    }
}
