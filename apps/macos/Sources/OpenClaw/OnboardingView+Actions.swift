import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
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

        // Close onboarding before asking the app shell to recover a visible
        // surface. If onboarding is still visible, the recovery loop thinks a
        // usable consumer surface already exists and never retries Settings.
        OnboardingController.shared.close()

        guard let followUpTab else { return }
        if let delegate = AppDelegate.shared {
            DispatchQueue.main.async {
                delegate.requestVisibleSurface(reason: "finish", preferredSettingsTab: followUpTab)
            }
            return
        }
        DispatchQueue.main.async {
            SettingsWindowOpener.shared.open(tab: followUpTab)
        }
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}
