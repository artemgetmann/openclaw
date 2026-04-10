import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

private typealias ProtoAnyCodable = OpenClawProtocol.AnyCodable

@Suite(.serialized)
@MainActor
struct OnboardingWizardModelTests {
    @Test func `preflights and repairs installable setup issues before gateway activation`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: ["gatewayPort": nil])
        {
            let wizard = OnboardingWizardModel()
            var callOrder: [String] = []
            var waitCalls = 0
            var installCalls = 0
            var requestCalls = 0

            let dependencies = OnboardingWizardStartupDependencies(
                activateGateway: {
                    callOrder.append("activate")
                },
                checkGatewayEnvironment: {
                    callOrder.append("check")
                    return GatewayEnvironmentStatus(
                        kind: .missingNode,
                        nodeVersion: nil,
                        gatewayVersion: nil,
                        requiredGateway: "2026.4.10",
                        message: "openclaw needs Node >=22.16.0 but found no runtime.")
                },
                installCLI: { statusHandler in
                    callOrder.append("install")
                    installCalls += 1
                    await statusHandler("Installed openclaw 2026.4.10.")
                    return true
                },
                waitForGatewayReady: { _ in
                    callOrder.append("wait")
                    waitCalls += 1
                    return waitCalls >= 1
                },
                requestWizardStart: { _ in
                    callOrder.append("request")
                    requestCalls += 1
                    return WizardStartResult(
                        sessionid: "wizard-session-1",
                        done: false,
                        step: nil,
                        status: ProtoAnyCodable("running"),
                        error: nil)
                })

            await wizard.startIfNeeded(mode: .local, dependencies: dependencies)

            #expect(callOrder == ["check", "install", "activate", "wait", "request"])
            #expect(installCalls == 1)
            #expect(waitCalls == 1)
            #expect(requestCalls == 1)
            #expect(wizard.sessionId == "wizard-session-1")
            #expect(wizard.status == "running")
            #expect(wizard.errorMessage == nil)
        }
    }

    @Test func `surfaces installer failure text when repair does not complete`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: ["gatewayPort": nil])
        {
            let wizard = OnboardingWizardModel()
            var callOrder: [String] = []
            var installCalls = 0
            var waitCalls = 0
            var requestCalls = 0

            let dependencies = OnboardingWizardStartupDependencies(
                activateGateway: {
                    callOrder.append("activate")
                },
                checkGatewayEnvironment: {
                    callOrder.append("check")
                    return GatewayEnvironmentStatus(
                        kind: .missingGateway,
                        nodeVersion: nil,
                        gatewayVersion: nil,
                        requiredGateway: "2026.4.10",
                        message: "openclaw CLI missing")
                },
                installCLI: { statusHandler in
                    callOrder.append("install")
                    installCalls += 1
                    await statusHandler("Install failed: Git missing.")
                    return false
                },
                waitForGatewayReady: { _ in
                    callOrder.append("wait")
                    waitCalls += 1
                    return false
                },
                requestWizardStart: { _ in
                    callOrder.append("request")
                    requestCalls += 1
                    return WizardStartResult(
                        sessionid: "wizard-session-2",
                        done: false,
                        step: nil,
                        status: ProtoAnyCodable("running"),
                        error: nil)
                })

            await wizard.startIfNeeded(mode: .local, dependencies: dependencies)

            #expect(callOrder == ["check", "install"])
            #expect(installCalls == 1)
            #expect(waitCalls == 0)
            #expect(requestCalls == 0)
            #expect(wizard.sessionId == nil)
            #expect(wizard.status == "error")
            #expect(wizard.errorMessage?.contains("Install failed: Git missing.") == true)
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
                installCLI: { _ in
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
