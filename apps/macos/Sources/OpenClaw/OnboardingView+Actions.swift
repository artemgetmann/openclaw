import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    static var consumerPostBrowserSetupTab: SettingsTab { .channels }

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
        if AppFlavor.current.isConsumer {
            // Consumer onboarding should hand off to the next required step, not
            // imply the setup is already finished. Channels is where Telegram lives.
            self.openSettings(tab: Self.consumerPostBrowserSetupTab)
        }
        OnboardingController.shared.close()
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}
