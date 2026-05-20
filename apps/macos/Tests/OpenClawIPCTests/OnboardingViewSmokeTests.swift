import Foundation
import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingViewSmokeTests {
    @Test func `onboarding view builds body`() {
        let state = AppState(preview: true)
        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
        _ = view.body
    }

    @Test func `standard page order omits workspace and identity steps`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "standard"]) {
            let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
            #expect(!order.contains(7))
            #expect(order.contains(3))
        }
    }

    @Test func `page order omits onboarding chat when identity known`() {
        let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
        #expect(!order.contains(8))
    }

    @Test func `consumer local onboarding uses one setup shell`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
            #expect(order == [0])
        }
    }

    @Test func `consumer first run defaults unconfigured state to same two-screen flow`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let order = OnboardingView.pageOrder(for: .unconfigured, showOnboardingChat: false)
            #expect(order == [0])
        }
    }

    @Test func `consumer setup steps stay in expected order`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            #expect(ConsumerSetupStep.allCases == [.chrome, .permissions, .aiAccess, .telegram])
            #expect(ConsumerSetupStep.chrome.next == .permissions)
            #expect(ConsumerSetupStep.permissions.previous == .chrome)
            #expect(ConsumerSetupStep.telegram.next == nil)
        }
    }

    @Test func `consumer setup shell builds each step page`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let state = AppState(preview: true)
            state.connectionMode = .local
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))

            for step in ConsumerSetupStep.allCases {
                view.consumerSetupStep = step
                _ = view.consumerSetupPage()
                _ = view.navigationBar
            }
        }
    }

    @Test func `debug step override opens consumer setup to telegram for ui smoke`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let state = AppState(preview: true)
            state.connectionMode = .local
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName),
                consumerSetupDebugStepEnvironment: ["OPENCLAW_CONSUMER_SETUP_DEBUG_STEP": "telegram"])

            #expect(view.consumerSetupStep == .telegram)
        }
    }

    @Test func `consumer setup navigation does not finish when prior steps are incomplete`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let state = AppState(preview: true)
            state.connectionMode = .local
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))

            view.consumerSetupStep = .telegram

            #expect(view.isConsumerSetupShellActive)
            #expect(!view.canAdvance)
        }
    }

    @Test func `consumer explicit remote mode still exposes connection page`() async {
        await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let order = OnboardingView.pageOrder(for: .remote, showOnboardingChat: false)
            #expect(order == [0, 1, 3])
        }
    }

    @Test func `select remote gateway clears stale ssh target when endpoint unresolved`() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host:2222"
            let view = OnboardingView(
                state: state,
                permissionMonitor: PermissionMonitor.shared,
                discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
            let gateway = GatewayDiscoveryModel.DiscoveredGateway(
                displayName: "Unresolved",
                serviceHost: nil,
                servicePort: nil,
                lanHost: "txt-host.local",
                tailnetDns: "txt-host.ts.net",
                sshPort: 22,
                gatewayPort: 18789,
                cliPath: "/tmp/openclaw",
                stableID: UUID().uuidString,
                debugID: UUID().uuidString,
                isLocal: false)

            view.selectRemoteGateway(gateway)
            #expect(state.remoteTarget.isEmpty)
        }
    }
}
