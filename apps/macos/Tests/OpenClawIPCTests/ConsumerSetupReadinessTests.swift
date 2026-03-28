import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConsumerSetupReadinessTests {
    @Test func `consumer model readiness marks ready after live gateway probe`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                ConsumerModelsReadinessPayload(
                    status: "ready",
                    defaultModel: "openai-codex/gpt-5.4",
                    summary: "OpenClaw-managed AI passed a live readiness check for the default model.",
                    reasonCodes: [])
            })

        await model.refresh()

        #expect(model.isComplete)
        #expect(model.phase == .ready("openai-codex/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.4.")
    }

    @Test func `consumer model readiness surfaces blocked live probe summary`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                ConsumerModelsReadinessPayload(
                    status: "blocked",
                    defaultModel: "openai-codex/gpt-5.4",
                    summary: "OpenClaw-managed AI is configured, but the shared auth is no longer usable.",
                    reasonCodes: ["probe_auth_failed"])
            })

        await model.refresh()

        #expect(!model.isComplete)
        #expect(model.phase == .failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))
        #expect(model.statusLine == "OpenClaw-managed AI is configured, but the shared auth is no longer usable.")
    }
}
