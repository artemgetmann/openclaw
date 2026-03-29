import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    enum FinishSurfaceHandoffAction: Equatable {
        case completeClose
        case retryVisibleSurface
        case restoreOnboarding
    }

    static func postFinishSettingsTab(
        isConsumer: Bool,
        connectionMode: AppState.ConnectionMode,
        telegramReady: Bool) -> SettingsTab?
    {
        guard isConsumer else { return nil }
        // Consumer setup should never close into menu-bar-only limbo. Incomplete
        // setup returns the user to Channels for recovery; a successful local
        // finish lands on General so the app still has a visible home.
        if connectionMode != .local || !telegramReady {
            return .channels
        }
        return .general
    }

    static func finishSurfaceHandoffAction(
        hasReplacementContentWindow: Bool,
        attemptsRemaining: Int) -> FinishSurfaceHandoffAction
    {
        if hasReplacementContentWindow {
            return .completeClose
        }
        if attemptsRemaining > 0 {
            return .retryVisibleSurface
        }
        return .restoreOnboarding
    }

    func selectLocalGateway() {
        self.state.connectionMode = .local
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectUnconfiguredGateway() {
        Task { await self.onboardingWizard.cancelIfRunning() }
        self.state.connectionMode = .unconfigured
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        Task { await self.onboardingWizard.cancelIfRunning() }
        self.preferredGatewayID = gateway.stableID
        GatewayDiscoveryPreferences.setPreferredStableID(gateway.stableID)
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: self.state)

        self.state.connectionMode = .remote
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID)
    }

    func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        self.openSettings()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    func handleNext() {
        if self.isWizardBlocking { return }
        if AppFlavor.current.isConsumer,
           self.activePageIndex == 0,
           self.state.connectionMode == .unconfigured
        {
            // Consumer onboarding defaults to local mode instead of making the
            // user choose infrastructure on first launch.
            self.selectLocalGateway()
        }
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    func finish() {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true

        let followUpTab = Self.postFinishSettingsTab(
            isConsumer: AppFlavor.current.isConsumer,
            connectionMode: self.state.connectionMode,
            telegramReady: self.channelsStore.consumerTelegramReadyForFirstTask())

        guard let followUpTab else {
            OnboardingController.shared.close()
            return
        }

        // Hide onboarding immediately so the handoff looks clean, but do not
        // destroy the only visible surface until Settings has actually appeared.
        // If the settings-open path flakes in accessory mode, we restore the
        // onboarding window instead of making the whole app look dead.
        OnboardingController.shared.beginVisibleSurfaceHandoff()
        Self.requestFinishVisibleSurface(tab: followUpTab, reason: "finish")
        // Give the replacement surface longer than the generic activation
        // recovery path. Finishing onboarding can coincide with settings scene
        // creation, activation-policy churn, and first-run state writes.
        Self.monitorFinishVisibleSurfaceHandoff(tab: followUpTab, attemptsRemaining: 10)
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }

    private static func requestFinishVisibleSurface(tab: SettingsTab, reason: String) {
        if let delegate = AppDelegate.shared {
            DispatchQueue.main.async {
                delegate.requestVisibleSurface(reason: reason, preferredSettingsTab: tab)
            }
            return
        }
        DispatchQueue.main.async {
            SettingsWindowOpener.shared.open(tab: tab)
        }
    }

    private static func monitorFinishVisibleSurfaceHandoff(tab: SettingsTab, attemptsRemaining: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            switch Self.finishSurfaceHandoffAction(
                hasReplacementContentWindow: SettingsWindowOpener.hasReplacementContentWindow(),
                attemptsRemaining: attemptsRemaining)
            {
            case .completeClose:
                _ = OnboardingController.shared.completeVisibleSurfaceHandoffIfPossible()
            case .retryVisibleSurface:
                Self.requestFinishVisibleSurface(tab: tab, reason: "finish-retry")
                Self.monitorFinishVisibleSurfaceHandoff(tab: tab, attemptsRemaining: attemptsRemaining - 1)
            case .restoreOnboarding:
                OnboardingController.shared.restoreAfterFailedVisibleSurfaceHandoff()
            }
        }
    }
}
