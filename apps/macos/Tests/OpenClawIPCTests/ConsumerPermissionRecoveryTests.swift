import CoreGraphics
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

    @Test func `accessory panel aligns with the System Settings content column`() {
        let frame = ConsumerPermissionAccessoryPanelLayout.frame(
            panelSize: CGSize(width: 500, height: 112),
            systemSettingsFrame: CGRect(x: 200, y: 180, width: 900, height: 720),
            visibleScreenFrame: CGRect(x: 0, y: 0, width: 1440, height: 900))

        #expect(frame.origin.x == 470)
        #expect(frame.origin.y == 74)
    }

    @Test func `accessory panel stays on screen when Settings is near an edge`() {
        let frame = ConsumerPermissionAccessoryPanelLayout.frame(
            panelSize: CGSize(width: 500, height: 112),
            systemSettingsFrame: CGRect(x: 8, y: 4, width: 300, height: 600),
            visibleScreenFrame: CGRect(x: 0, y: 0, width: 1440, height: 900))

        #expect(frame.origin.x == 98)
        #expect(frame.origin.y == 12)
    }

    @Test func `accessory panel converts Quartz bounds through the primary display origin`() {
        let primaryDisplayMaxY: CGFloat = 900

        // Quartz Y is negative for a monitor above the primary display. AppKit
        // should place that same window above the primary display's top edge.
        let above = ConsumerPermissionAccessoryPanelLayout.appKitFrame(
            fromQuartzBounds: CGRect(x: 100, y: -500, width: 600, height: 400),
            primaryDisplayMaxY: primaryDisplayMaxY)
        #expect(above == CGRect(x: 100, y: 1000, width: 600, height: 400))

        // Quartz Y continues below the primary display for a monitor arranged
        // underneath it. AppKit represents that display with negative Y.
        let below = ConsumerPermissionAccessoryPanelLayout.appKitFrame(
            fromQuartzBounds: CGRect(x: 100, y: 900, width: 600, height: 400),
            primaryDisplayMaxY: primaryDisplayMaxY)
        #expect(below == CGRect(x: 100, y: -400, width: 600, height: 400))
    }

    @Test func `accessory panel copy names the exact accessibility list`() {
        #expect(ConsumerPermissionAccessoryPanelCopy.title(for: .accessibility) == "Accessibility")
        #expect(ConsumerPermissionAccessoryPanelCopy.instruction(for: .accessibility) == "Drag Jarvis into this list")
        #expect(!ConsumerPermissionAccessoryPanelCopy.instruction(for: .accessibility)
            .contains("Finish in System Settings"))
        #expect(!ConsumerPermissionAccessoryPanelCopy.instruction(for: .accessibility).contains("Turn on Jarvis"))
        #expect(ConsumerPermissionAccessoryPanelCopy.followUp == "Then turn it on.")
    }

    @Test func `accessory panel copy names the exact screen recording list`() {
        #expect(ConsumerPermissionAccessoryPanelCopy.title(for: .screenRecording) == "Screen & System Audio Recording")
        #expect(ConsumerPermissionAccessoryPanelCopy.instruction(for: .screenRecording) == "Drag Jarvis into this list")
        #expect(ConsumerPermissionAccessoryPanelCopy.followUp == "Then turn it on.")
    }

    @Test @MainActor func `product icon image view always applies the canonical rounded mask`() {
        let iconSize: CGFloat = 44
        let imageView = ProductAppIconImageView(size: iconSize)

        #expect(imageView.wantsLayer)
        #expect(imageView.layer?.masksToBounds == true)
        #expect(imageView.layer?.cornerCurve == .continuous)
        #expect(imageView.layer?.cornerRadius == ProductAppIconStyle.cornerRadius(for: iconSize))
        #expect(ProductAppIconStyle.continuousCornerRadiusRatio == 0.22)
    }
}
