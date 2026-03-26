import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerAppActivationTests {
    @Test func `consumer app schedules an initial visible surface during onboarding`() {
        #expect(
            AppDelegate.shouldScheduleInitialVisibleSurface(
                isConsumer: true,
                onboardingPending: true,
                didLaunchFromFinder: false))
    }

    @Test func `consumer app schedules an initial visible surface for Finder launch`() {
        #expect(
            AppDelegate.shouldScheduleInitialVisibleSurface(
                isConsumer: true,
                onboardingPending: false,
                didLaunchFromFinder: true))
    }

    @Test func `consumer app does not auto-surface when onboarding is done and launch was background only`() {
        #expect(
            !AppDelegate.shouldScheduleInitialVisibleSurface(
                isConsumer: true,
                onboardingPending: false,
                didLaunchFromFinder: false))
    }

    @Test func `standard app does not use consumer launch surfacing rules`() {
        #expect(
            !AppDelegate.shouldScheduleInitialVisibleSurface(
                isConsumer: false,
                onboardingPending: true,
                didLaunchFromFinder: true))
    }

    @Test func `consumer app handles reopen only when no windows are visible`() {
        #expect(
            AppDelegate.shouldHandleConsumerReopen(
                isConsumer: true,
                hasVisibleWindows: false))
        #expect(
            !AppDelegate.shouldHandleConsumerReopen(
                isConsumer: true,
                hasVisibleWindows: true))
        #expect(
            !AppDelegate.shouldHandleConsumerReopen(
                isConsumer: false,
                hasVisibleWindows: false))
    }

    @Test func `consumer first run keeps dock visible while onboarding is still pending`() {
        #expect(
            DockIconManager.shouldKeepConsumerDockVisible(
                isConsumer: true,
                onboardingPending: true,
                accessibilityGranted: true,
                screenRecordingGranted: true))
    }

    @Test func `consumer first run keeps dock visible while critical permissions are unresolved`() {
        #expect(
            DockIconManager.shouldKeepConsumerDockVisible(
                isConsumer: true,
                onboardingPending: false,
                accessibilityGranted: false,
                screenRecordingGranted: true))
        #expect(
            DockIconManager.shouldKeepConsumerDockVisible(
                isConsumer: true,
                onboardingPending: false,
                accessibilityGranted: true,
                screenRecordingGranted: false))
    }

    @Test func `dock icon can hide only after first run is actually recoverable`() {
        #expect(
            !DockIconManager.shouldKeepConsumerDockVisible(
                isConsumer: true,
                onboardingPending: false,
                accessibilityGranted: true,
                screenRecordingGranted: true))
        #expect(
            !DockIconManager.shouldKeepConsumerDockVisible(
                isConsumer: false,
                onboardingPending: true,
                accessibilityGranted: false,
                screenRecordingGranted: false))
    }

    @Test func `regular activation policy stays on while a visibility hold is active`() {
        #expect(
            DockIconManager.shouldUseRegularActivationPolicy(
                userWantsDockIcon: false,
                hasVisibleWindows: false,
                shouldKeepConsumerDockVisible: false,
                hasVisibilityHold: true))
    }
}
