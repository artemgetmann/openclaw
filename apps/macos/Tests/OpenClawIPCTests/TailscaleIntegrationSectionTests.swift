import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TailscaleIntegrationSectionTests {
    @Test func `turning tailscale off preserves local gateway token auth`() {
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "mode": "token",
                    "token": "stable-token",
                    "allowTailscale": true,
                ],
                "tailscale": [
                    "mode": "serve",
                ],
            ],
        ]

        let updated = TailscaleIntegrationSection._testUpdatedGatewayConfig(
            root: root,
            mode: "off",
            requireCredentialsForServe: false,
            password: "")
        let gateway = updated["gateway"] as? [String: Any]
        let auth = gateway?["auth"] as? [String: Any]
        let tailscale = gateway?["tailscale"] as? [String: Any]

        #expect(auth?["mode"] as? String == "token")
        #expect(auth?["token"] as? String == "stable-token")
        #expect(auth?["allowTailscale"] == nil)
        #expect(tailscale?["mode"] as? String == "off")
    }

    @Test func `tailscale section builds body when not installed`() {
        let service = TailscaleService(isInstalled: false, isRunning: false, statusError: "not installed")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(mode: "off", requireCredentials: false, statusMessage: "Idle")
        _ = view.body
    }

    @Test func `tailscale section builds body for serve mode`() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: true,
            tailscaleHostname: "openclaw.tailnet.ts.net",
            tailscaleIP: "100.64.0.1")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "serve",
            requireCredentials: true,
            password: "secret",
            statusMessage: "Running")
        _ = view.body
    }

    @Test func `tailscale section builds body for funnel mode`() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: false,
            tailscaleHostname: nil,
            tailscaleIP: nil,
            statusError: "not running")
        var view = TailscaleIntegrationSection(connectionMode: .remote, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "funnel",
            requireCredentials: false,
            statusMessage: "Needs start",
            validationMessage: "Invalid token")
        _ = view.body
    }
}
