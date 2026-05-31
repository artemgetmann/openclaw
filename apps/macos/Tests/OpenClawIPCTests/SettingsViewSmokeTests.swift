import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func `cron settings builds body`() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.schedulerStorePath = "/tmp/openclaw-cron-store.json"

        let job1 = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "  Morning Check-in  ",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            delivery: nil,
            state: CronJobState(
                nextRunAtMs: 1_700_000_200_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 123))

        let job2 = CronJob(
            id: "job-2",
            agentId: nil,
            name: "",
            description: nil,
            enabled: false,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_100_000,
            schedule: .every(everyMs: 30000, anchorMs: nil),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "hello",
                thinking: "low",
                timeoutSeconds: 30,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(mode: .announce, channel: "sms", to: "+15551234567", bestEffort: true),
            state: CronJobState(
                nextRunAtMs: nil,
                runningAtMs: nil,
                lastRunAtMs: nil,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))

        store.jobs = [job1, job2]
        store.selectedJobId = job1.id
        store.runEntries = [
            CronRunLogEntry(
                ts: 1_700_000_050_000,
                jobId: job1.id,
                action: "finished",
                status: "ok",
                error: nil,
                summary: "ok",
                runAtMs: 1_700_000_050_000,
                durationMs: 123,
                nextRunAtMs: 1_700_000_200_000),
        ]

        let view = CronSettings(store: store)
        _ = view.body
    }

    @Test func `cron settings exercises private views`() {
        CronSettings.exerciseForTesting()
    }

    @Test func `config settings builds body`() {
        let view = ConfigSettings()
        _ = view.body
    }

    @Test func `debug settings builds body`() {
        let view = DebugSettings()
        _ = view.body
    }

    @Test func `general settings builds body`() {
        let state = AppState(preview: true)
        let view = GeneralSettings(state: state)
        _ = view.body
    }

    @Test func `browser settings builds body`() {
        let view = BrowserSettings()
        _ = view.body
    }

    @Test func `ai access settings builds body`() {
        let view = AIAccessSettings()
        _ = view.body
    }

    @Test func `consumer defaults keep dock icon visible unless user changed it`() {
        #expect(AppState.defaultShowDockIcon(storedValue: nil, isConsumer: true))
        #expect(!AppState.defaultShowDockIcon(storedValue: false, isConsumer: true))
        #expect(!AppState.defaultShowDockIcon(storedValue: nil, isConsumer: false))
    }

    @Test func `consumer defaults do not create login item unless user opted in`() {
        #expect(!AppState.defaultLaunchAtLogin(isConsumer: true))
        #expect(!AppState.defaultLaunchAtLogin(isConsumer: false))
        #expect(AppState.launchAtLoginDisabledForThisProcess(arguments: ["OpenClaw", "--no-login-item"]))
        #expect(AppState.launchAtLoginDisabledForThisProcess(environment: ["OPENCLAW_DISABLE_LOGIN_ITEM": "true"]))
    }

    @Test func `general settings exercises branches`() {
        GeneralSettings.exerciseForTesting()
    }

    @Test func `sessions settings builds body`() {
        let view = SessionsSettings(rows: SessionRow.previewRows, isPreview: true)
        _ = view.body
    }

    @Test func `instances settings builds body`() {
        let store = InstancesStore(isPreview: true)
        store.instances = [
            InstanceInfo(
                id: "local",
                host: "this-mac",
                ip: "127.0.0.1",
                version: "1.0",
                platform: "macos 15.0",
                deviceFamily: "Mac",
                modelIdentifier: "MacPreview",
                lastInputSeconds: 12,
                mode: "local",
                reason: "test",
                text: "test instance",
                ts: Date().timeIntervalSince1970 * 1000),
        ]
        let view = InstancesSettings(store: store)
        _ = view.body
    }

    @Test func `permissions settings builds body`() {
        let view = PermissionsSettings(
            status: [
                .notifications: true,
                .screenRecording: false,
            ],
            refresh: {},
            showOnboarding: {})
        _ = view.body
    }

    @Test func `settings root view builds body`() {
        let state = AppState(preview: true)
        let view = SettingsRootView(state: state, updater: nil, initialTab: .general)
        _ = view.body
    }

    @Test func `consumer settings expose day one tabs but hide advanced tabs by default`() {
        let tabs = SettingsRootView.visibleTabs(
            isConsumer: true,
            showAdvancedSettings: false,
            debugPaneEnabled: true)
        #expect(tabs == [.general, .channels, .browser, .aiAccess, .permissions, .about])
    }

    @Test func `consumer advanced settings reveal hidden tabs`() {
        let tabs = SettingsRootView.visibleTabs(
            isConsumer: true,
            showAdvancedSettings: true,
            debugPaneEnabled: true)
        #expect(tabs.contains(.channels))
        #expect(tabs.contains(.skills))
        #expect(tabs.contains(.debug))
    }

    @Test func `settings window opener recognizes real content windows`() {
        #expect(SettingsWindowOpener.isContentWindowCandidate(
            frameWidth: SettingsTab.windowWidth,
            frameHeight: SettingsTab.windowHeight,
            isPanel: false,
            className: "SwiftUI.AppKitWindow",
            hasContentView: true,
            hasContentViewController: false))
        #expect(!SettingsWindowOpener.isContentWindowCandidate(
            frameWidth: 1,
            frameHeight: SettingsTab.windowHeight,
            isPanel: false,
            className: "SwiftUI.AppKitWindow",
            hasContentView: true,
            hasContentViewController: false))
        #expect(!SettingsWindowOpener.isContentWindowCandidate(
            frameWidth: SettingsTab.windowWidth,
            frameHeight: SettingsTab.windowHeight,
            isPanel: true,
            className: "NSPanel",
            hasContentView: true,
            hasContentViewController: false))
        #expect(!SettingsWindowOpener.isContentWindowCandidate(
            frameWidth: SettingsTab.windowWidth,
            frameHeight: SettingsTab.windowHeight,
            isPanel: false,
            className: "NSPopupMenuWindow",
            hasContentView: true,
            hasContentViewController: false))
    }

    @Test func `consumer app delegate schedules launch surface only when useful`() {
        #expect(AppDelegate.shouldScheduleInitialVisibleSurface(
            isConsumer: true,
            onboardingPending: true,
            didLaunchFromFinder: false))
        #expect(AppDelegate.shouldScheduleInitialVisibleSurface(
            isConsumer: true,
            onboardingPending: false,
            didLaunchFromFinder: true))
        #expect(!AppDelegate.shouldScheduleInitialVisibleSurface(
            isConsumer: true,
            onboardingPending: false,
            didLaunchFromFinder: false))
        #expect(!AppDelegate.shouldScheduleInitialVisibleSurface(
            isConsumer: false,
            onboardingPending: true,
            didLaunchFromFinder: true))
    }

    @Test func `consumer app delegate requests surface on reopen without windows`() {
        #expect(AppDelegate.shouldHandleConsumerReopen(
            isConsumer: true,
            hasVisibleWindows: false))
        #expect(!AppDelegate.shouldHandleConsumerReopen(
            isConsumer: true,
            hasVisibleWindows: true))
        #expect(!AppDelegate.shouldHandleConsumerReopen(
            isConsumer: false,
            hasVisibleWindows: false))
    }

    @Test func `consumer app delegate recovers activation only without visible surface`() {
        #expect(AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
            isConsumer: true,
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: false))
        #expect(!AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
            isConsumer: true,
            hasVisibleContentWindow: true,
            hasVisibleOnboardingWindow: false))
        #expect(!AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
            isConsumer: true,
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: true))
        #expect(!AppDelegate.shouldRecoverVisibleSurfaceOnActivation(
            isConsumer: false,
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: false))
    }

    @Test func `consumer app delegate retries until a visible surface exists`() {
        #expect(AppDelegate.shouldRetryVisibleSurfaceRecovery(
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: false,
            attemptsRemaining: 1))
        #expect(!AppDelegate.shouldRetryVisibleSurfaceRecovery(
            hasVisibleContentWindow: true,
            hasVisibleOnboardingWindow: false,
            attemptsRemaining: 1))
        #expect(!AppDelegate.shouldRetryVisibleSurfaceRecovery(
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: true,
            attemptsRemaining: 1))
        #expect(!AppDelegate.shouldRetryVisibleSurfaceRecovery(
            hasVisibleContentWindow: false,
            hasVisibleOnboardingWindow: false,
            attemptsRemaining: 0))
    }

    @Test func `consumer app delegate recognizes visible onboarding windows`() {
        #expect(AppDelegate.isVisibleOnboardingWindowCandidate(
            title: UIStrings.welcomeTitle,
            isVisible: true,
            frameWidth: OnboardingView.windowWidth,
            frameHeight: OnboardingView.windowHeight))
        #expect(!AppDelegate.isVisibleOnboardingWindowCandidate(
            title: UIStrings.welcomeTitle,
            isVisible: false,
            frameWidth: OnboardingView.windowWidth,
            frameHeight: OnboardingView.windowHeight))
        #expect(!AppDelegate.isVisibleOnboardingWindowCandidate(
            title: "Settings",
            isVisible: true,
            frameWidth: OnboardingView.windowWidth,
            frameHeight: OnboardingView.windowHeight))
        #expect(!AppDelegate.isVisibleOnboardingWindowCandidate(
            title: UIStrings.welcomeTitle,
            isVisible: true,
            frameWidth: 1,
            frameHeight: OnboardingView.windowHeight))
    }

    @Test func `about settings builds body`() {
        let view = AboutSettings(updater: nil)
        _ = view.body
    }

    @Test func `voice wake settings builds body`() {
        let state = AppState(preview: true)
        let view = VoiceWakeSettings(state: state, isActive: false)
        _ = view.body
    }

    @Test func `skills settings builds body`() {
        let view = SkillsSettings(state: .preview)
        _ = view.body
    }
}
