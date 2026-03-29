import AppKit
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

    @Test func `consumer activation recovers a visible surface only when none exists`() {
        #expect(
            AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
                isConsumer: true,
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: false))
        #expect(
            !AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
                isConsumer: true,
                hasVisibleContentWindow: true,
                hasVisibleOnboardingWindow: false))
        #expect(
            !AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
                isConsumer: true,
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: true))
        #expect(
            !AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
                isConsumer: false,
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: false))
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

    @Test func `visible surface recovery stops once onboarding or settings is visible`() {
        #expect(
            AppDelegate.hasVisibleConsumerSurface(
                hasVisibleContentWindow: true,
                hasVisibleOnboardingWindow: false))
        #expect(
            AppDelegate.hasVisibleConsumerSurface(
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: true))
        #expect(
            !AppDelegate.hasVisibleConsumerSurface(
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: false))
    }

    @Test func `visible surface recovery retries only while consumer launch is still invisible`() {
        #expect(
            AppDelegate.shouldRetryVisibleSurfaceRecovery(
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: false,
                attemptsRemaining: 4))
        #expect(
            !AppDelegate.shouldRetryVisibleSurfaceRecovery(
                hasVisibleContentWindow: true,
                hasVisibleOnboardingWindow: false,
                attemptsRemaining: 4))
        #expect(
            !AppDelegate.shouldRetryVisibleSurfaceRecovery(
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: true,
                attemptsRemaining: 4))
        #expect(
            !AppDelegate.shouldRetryVisibleSurfaceRecovery(
                hasVisibleContentWindow: false,
                hasVisibleOnboardingWindow: false,
                attemptsRemaining: 0))
    }

    @Test func `consumer finish routes incomplete setup back to channels`() {
        #expect(
            OnboardingView.postFinishSettingsTab(
                isConsumer: true,
                connectionMode: .local,
                telegramReady: false) == .channels)
        #expect(
            OnboardingView.postFinishSettingsTab(
                isConsumer: true,
                connectionMode: .remote,
                telegramReady: true) == .channels)
    }

    @Test func `consumer finish keeps successful local setup on a visible general surface`() {
        #expect(
            OnboardingView.postFinishSettingsTab(
                isConsumer: true,
                connectionMode: .local,
                telegramReady: true) == .general)
    }

    @Test func `finish handoff closes onboarding once settings is visible`() {
        #expect(
            OnboardingView.finishSurfaceHandoffAction(
                hasReplacementContentWindow: true,
                attemptsRemaining: 4) == .completeClose)
    }

    @Test func `finish handoff retries while replacement surface is still missing`() {
        #expect(
            OnboardingView.finishSurfaceHandoffAction(
                hasReplacementContentWindow: false,
                attemptsRemaining: 4) == .retryVisibleSurface)
    }

    @Test func `finish handoff restores onboarding after retries are exhausted`() {
        #expect(
            OnboardingView.finishSurfaceHandoffAction(
                hasReplacementContentWindow: false,
                attemptsRemaining: 0) == .restoreOnboarding)
    }

    @Test func `replacement window detection excludes onboarding`() {
        let onboarding = NSWindow()
        onboarding.identifier = OnboardingController.windowIdentifier
        onboarding.contentViewController = NSViewController()
        onboarding.setContentSize(NSSize(width: 630, height: 752))

        let settings = NSWindow()
        settings.contentViewController = NSViewController()
        settings.setContentSize(NSSize(width: 800, height: 600))

        #expect(SettingsWindowOpener.isContentWindowCandidate(onboarding))
        #expect(SettingsWindowOpener.isOnboardingWindow(onboarding))
        #expect(SettingsWindowOpener.isContentWindowCandidate(settings))
        #expect(!SettingsWindowOpener.isOnboardingWindow(settings))
    }

    @Test func `settings window counts as replacement content even without a content view controller`() {
        #expect(
            SettingsWindowOpener.isContentWindowCandidate(
                frameWidth: 824,
                frameHeight: 878,
                isPanel: false,
                className: "NSWindow",
                hasContentView: true,
                hasContentViewController: false))
    }

    @Test func `popup menu windows never count as replacement content`() {
        #expect(
            !SettingsWindowOpener.isContentWindowCandidate(
                frameWidth: 300,
                frameHeight: 200,
                isPanel: false,
                className: "NSPopupMenuWindow",
                hasContentView: true,
                hasContentViewController: true))
    }

    @Test func `non consumer finish does not force a settings follow up`() {
        #expect(
            OnboardingView.postFinishSettingsTab(
                isConsumer: false,
                connectionMode: .local,
                telegramReady: true) == nil)
    }

    @Test func `consumer defaults keep dock and launch available on first run`() {
        #expect(AppState.defaultLaunchAtLogin(isConsumer: true))
        #expect(AppState.defaultShowDockIcon(storedValue: nil, isConsumer: true))
        #expect(!AppState.defaultLaunchAtLogin(isConsumer: false))
        #expect(!AppState.defaultShowDockIcon(storedValue: nil, isConsumer: false))
    }
}
