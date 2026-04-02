import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallPrompterTests {
    @Test func `consumer build never shows CLI install prompt`() {
        #expect(
            !CLIInstallPrompter.shouldPrompt(
                isPrompting: false,
                isConsumer: true,
                onboardingSeen: true,
                connectionMode: .local,
                installedLocation: nil,
                appVersion: "1.2.3",
                lastPromptedVersion: nil))
    }

    @Test func `standard local build still prompts when helper missing`() {
        #expect(
            CLIInstallPrompter.shouldPrompt(
                isPrompting: false,
                isConsumer: false,
                onboardingSeen: true,
                connectionMode: .local,
                installedLocation: nil,
                appVersion: "1.2.3",
                lastPromptedVersion: "1.2.2"))
    }
}
