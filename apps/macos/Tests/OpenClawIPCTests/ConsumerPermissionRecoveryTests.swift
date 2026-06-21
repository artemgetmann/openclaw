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
        #expect(presentation.statusText == "Not allowed yet")
        #expect(presentation.detailText == nil)
    }

    @Test func `special permission directs user to system settings after failed attempt`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.displayState == .needsSystemSettings)
        #expect(presentation.actionLabel == "Help")
        #expect(presentation.statusText == "Needs approval")
        #expect(presentation.detailText?.contains("Screen & System Audio Recording") == true)
        #expect(presentation.detailText?.contains("Turn on") == true)
    }

    @Test func `accessibility keeps settings help after app reactivation`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: false,
            isChecking: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))

        #expect(presentation.displayState == .needsSystemSettings)
        #expect(presentation.actionLabel == "Help")
        #expect(presentation.statusText == "Needs approval")
        #expect(presentation.detailText?.contains("Accessibility") == true)
        #expect(presentation.detailText?.contains("Turn on") == true)
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
        #expect(presentation.actionLabel == "Help")
        #expect(presentation.statusText == "Needs approval")
    }

    @Test func `screen recording keeps help action when restart recovery is available`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))

        #expect(presentation.displayState == .needsSystemSettings)
        #expect(presentation.actionLabel == "Help")
        #expect(presentation.detailText?.contains("Screen & System Audio Recording") == true)
        let needsRestart = ConsumerPermissionRecoverySupport.needsRestartRecovery(
            for: .screenRecording,
            granted: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))
        #expect(needsRestart)
    }

    @Test func `accessibility recovery detail explains exactly what to click`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .accessibility,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.actionLabel == "Help")
        #expect(presentation.detailText?.contains("Accessibility") == true)
        #expect(presentation.detailText?.contains("Turn on") == true)
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

    @Test func `recommended summary stays compact after attempted flow`() {
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

        #expect(summary == "2 recommended permissions still need attention.")
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

    @Test func `accessibility never enters restart recovery`() {
        let needsRestart = ConsumerPermissionRecoverySupport.needsRestartRecovery(
            for: .accessibility,
            granted: false,
            context: .init(
                attemptedSettingsRecovery: true,
                requestedExplicitSettingsFollowUp: true,
                reactivatedAfterSettings: true))
        #expect(!needsRestart)
    }

    @Test func `explicit settings follow-up marks context for restart recovery eligibility`() {
        let context = ConsumerPermissionRecoverySupport.explicitSettingsFollowUpContext(
            from: .init(
                attemptedSettingsRecovery: false,
                requestedExplicitSettingsFollowUp: false,
                reactivatedAfterSettings: true))

        #expect(context.attemptedSettingsRecovery)
        #expect(context.requestedExplicitSettingsFollowUp)
        #expect(!context.reactivatedAfterSettings)
    }

    @Test func `screen recording detail explains blank system settings fallback`() {
        let presentation = ConsumerPermissionRecoverySupport.presentation(
            for: .screenRecording,
            granted: false,
            isChecking: false,
            context: .init(attemptedSettingsRecovery: true, reactivatedAfterSettings: false))

        #expect(presentation.detailText?.contains("Screen & System Audio Recording") == true)
        #expect(presentation.detailText?.contains("Turn on") == true)
    }

    @Test func `recovery sheet maps only manual privacy capabilities`() {
        #expect(ConsumerPermissionRecoverySupport.RecoverySheet(capability: .accessibility)?.capability == .accessibility)
        #expect(ConsumerPermissionRecoverySupport.RecoverySheet(capability: .screenRecording)?.capability == .screenRecording)
        #expect(ConsumerPermissionRecoverySupport.RecoverySheet(capability: .location) == nil)
        #expect(ConsumerPermissionRecoverySupport.RecoverySheet(capability: .appleScript) == nil)
    }

    @Test func `bulk grant excludes manual privacy permissions`() {
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.screenRecording))
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.accessibility))
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.notifications))
        #expect(!PermissionsSettings.consumerBulkGrantCapabilities.contains(.microphone))
        #expect(PermissionsSettings.consumerBulkGrantCapabilities.contains(.appleScript))
        #expect(PermissionsSettings.consumerBulkGrantCapabilities.contains(.location))
    }

    @Test func `consumer settings keeps media permissions optional`() {
        #expect(PermissionsSettings.consumerRecommendedCapabilities == [
            .accessibility,
            .screenRecording,
            .location,
        ])
        #expect(PermissionsSettings.consumerRecommendedCapabilities.contains(.screenRecording))
        #expect(PermissionsSettings.consumerRecommendedCapabilities.contains(.accessibility))
        #expect(PermissionsSettings.consumerRecommendedCapabilities.contains(.location))
        #expect(!PermissionsSettings.consumerRecommendedCapabilities.contains(.appleScript))
        #expect(!PermissionsSettings.consumerRecommendedCapabilities.contains(.notifications))
        #expect(!PermissionsSettings.consumerRecommendedCapabilities.contains(.microphone))
        #expect(ConsumerPermissionCatalog.optionalCapabilities.contains(.appleScript))
    }

    @Test func `core onboarding permissions include app control but keep location recommended`() {
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.accessibility))
        #expect(ConsumerPermissionCatalog.coreCapabilities.contains(.screenRecording))
        #expect(!ConsumerPermissionCatalog.coreCapabilities.contains(.appleScript))
        #expect(!ConsumerPermissionCatalog.coreCapabilities.contains(.location))
        #expect(!ConsumerPermissionCatalog.recommendedOnboardingCapabilities.contains(.appleScript))
        #expect(ConsumerPermissionCatalog.recommendedOnboardingCapabilities.contains(.location))
    }

    @Test func `core request order asks for accessibility before screen recording`() {
        let accessibilityIndex = ConsumerPermissionCatalog.coreRequestOrder.firstIndex(of: .accessibility)
        let screenIndex = ConsumerPermissionCatalog.coreRequestOrder.firstIndex(of: .screenRecording)
        let locationIndex = ConsumerPermissionCatalog.coreRequestOrder.firstIndex(of: .location)

        #expect(!ConsumerPermissionCatalog.coreRequestOrder.contains(.appleScript))
        #expect(accessibilityIndex != nil)
        #expect(screenIndex != nil)
        #expect(locationIndex != nil)
        #expect(accessibilityIndex! < screenIndex!)
        #expect(screenIndex! < locationIndex!)
    }

    @Test func `core request flow pauses after unresolved special permission`() {
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .appleScript, granted: false))
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .location, granted: false))
        #expect(ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .screenRecording, granted: false))
        #expect(ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .accessibility, granted: false))
        #expect(!ConsumerPermissionCatalog.shouldPauseCoreRequestFlow(after: .screenRecording, granted: true))
    }
}
