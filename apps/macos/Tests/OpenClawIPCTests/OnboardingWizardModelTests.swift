import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

private typealias ProtoAnyCodable = OpenClawProtocol.AnyCodable

@Suite(.serialized)
@MainActor
struct OnboardingWizardModelTests {
    @Test func `self heals local setup once when node is missing`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: ["gatewayPort": nil])
        {
            let wizard = OnboardingWizardModel()
            var waitCalls = 0
            var installCalls = 0
            var requestCalls = 0

            let dependencies = OnboardingWizardStartupDependencies(
                activateGateway: {},
                checkGatewayEnvironment: {
                    GatewayEnvironmentStatus(
                        kind: .missingNode,
                        nodeVersion: nil,
                        gatewayVersion: nil,
                        requiredGateway: "2026.4.10",
                        message: "openclaw needs Node >=22.16.0 but found no runtime.")
                },
                installCLI: {
                    installCalls += 1
                    return true
                },
                waitForGatewayReady: { _ in
                    waitCalls += 1
                    return waitCalls >= 2
                },
                requestWizardStart: { _ in
                    requestCalls += 1
                    return WizardStartResult(
                        sessionid: "wizard-session-1",
                        done: false,
                        step: nil,
                        status: ProtoAnyCodable("running"),
                        error: nil)
                })

            await wizard.startIfNeeded(mode: .local, dependencies: dependencies)

            #expect(installCalls == 1)
            #expect(waitCalls == 2)
            #expect(requestCalls == 1)
            #expect(wizard.sessionId == "wizard-session-1")
            #expect(wizard.status == "running")
            #expect(wizard.errorMessage == nil)
        }
    }

    @Test func `preserves installable failure detail when no repair applies`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: ["gatewayPort": nil])
        {
            let wizard = OnboardingWizardModel()
            var waitCalls = 0
            var installCalls = 0
            var requestCalls = 0

            let dependencies = OnboardingWizardStartupDependencies(
                activateGateway: {},
                checkGatewayEnvironment: {
                    GatewayEnvironmentStatus(
                        kind: .error("manual repair required"),
                        nodeVersion: nil,
                        gatewayVersion: nil,
                        requiredGateway: nil,
                        message: "manual repair required")
                },
                installCLI: {
                    installCalls += 1
                    return true
                },
                waitForGatewayReady: { _ in
                    waitCalls += 1
                    return false
                },
                requestWizardStart: { _ in
                    requestCalls += 1
                    return WizardStartResult(
                        sessionid: "wizard-session-2",
                        done: false,
                        step: nil,
                        status: ProtoAnyCodable("running"),
                        error: nil)
                })

            await wizard.startIfNeeded(mode: .local, dependencies: dependencies)

            #expect(waitCalls == 1)
            #expect(installCalls == 0)
            #expect(requestCalls == 0)
            #expect(wizard.sessionId == nil)
            #expect(wizard.status == "error")
            #expect(wizard.errorMessage?.contains("manual repair required") == true)
        }
    }
}
