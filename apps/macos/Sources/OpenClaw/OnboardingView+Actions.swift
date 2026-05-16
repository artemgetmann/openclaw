import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
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
        if self.isConsumerSetupShellActive,
           let previousStep = self.consumerSetupStep.previous
        {
            withAnimation {
                self.consumerSetupStep = previousStep
            }
            return
        }

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
        if self.isConsumerSetupShellActive {
            if let nextStep = self.consumerSetupStep.next {
                withAnimation {
                    self.consumerSetupStep = nextStep
                }
            } else {
                self.finish()
            }
            return
        }
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    func finish() {
        self.markOnboardingComplete()
        OnboardingController.shared.close()
    }

    func markOnboardingComplete() {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
    }

    func attemptConsumerSetupResume() async -> Bool {
        guard AppFlavor.current.isConsumer else { return false }
        guard self.state.connectionMode == .local else { return false }
        let decision = await self.setupResume.evaluate(
            browserSetup: self.browserSetup,
            modelSetup: self.modelSetup,
            channelsStore: self.channelsStore,
            corePermissionsGranted: self.areCorePermissionsGranted)
        guard decision == .complete else { return false }
        self.markOnboardingComplete()
        OnboardingController.shared.close()
        return true
    }

    func loadConsumerTelegramSetupStateIfNeeded() async {
        guard AppFlavor.current.isConsumer else { return }
        guard self.state.connectionMode == .local else { return }
        await self.channelsStore.restoreConfigDraftFromCurrentSource()
        await self.channelsStore.refresh(probe: true)
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}

extension ConsumerSetupStep {
    var previous: ConsumerSetupStep? {
        guard let index = Self.allCases.firstIndex(of: self), index > Self.allCases.startIndex else {
            return nil
        }
        return Self.allCases[Self.allCases.index(before: index)]
    }

    var next: ConsumerSetupStep? {
        guard let index = Self.allCases.firstIndex(of: self) else { return nil }
        let nextIndex = Self.allCases.index(after: index)
        guard nextIndex < Self.allCases.endIndex else { return nil }
        return Self.allCases[nextIndex]
    }
}
