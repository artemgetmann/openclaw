import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerAppActivationTests {
    @Test func `consumer app surfaces settings when activated without visible windows`() {
        #expect(
            AppDelegate.shouldSurfaceConsumerSettingsOnActivation(
                isConsumer: true,
                onboardingVisible: false,
                hasVisibleContentWindow: false))
    }

    @Test func `consumer app does not surface settings during onboarding`() {
        #expect(
            !AppDelegate.shouldSurfaceConsumerSettingsOnActivation(
                isConsumer: true,
                onboardingVisible: true,
                hasVisibleContentWindow: false))
    }

    @Test func `consumer app does not surface settings when a window is already visible`() {
        #expect(
            !AppDelegate.shouldSurfaceConsumerSettingsOnActivation(
                isConsumer: true,
                onboardingVisible: false,
                hasVisibleContentWindow: true))
    }

    @Test func `standard app does not force consumer settings reopen behavior`() {
        #expect(
            !AppDelegate.shouldSurfaceConsumerSettingsOnActivation(
                isConsumer: false,
                onboardingVisible: false,
                hasVisibleContentWindow: false))
    }
}
