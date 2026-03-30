import Foundation
import Testing
@testable import OpenClaw

private func blockedReadinessPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "blocked",
        defaultModel: "openai-codex/gpt-5.4",
        summary: "OpenClaw-managed AI is configured, but the shared auth is no longer usable.",
        reasonCodes: ["probe_auth_failed"])
}

private func readyReadinessPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "ready",
        defaultModel: "openai-codex/gpt-5.4",
        summary: "OpenClaw-managed AI passed a live readiness check for the default model.",
        reasonCodes: [])
}

private func authOptionPayload() -> ConsumerModelsAuthOptionPayload {
    ConsumerModelsAuthOptionPayload(
        id: "openai-api-key",
        providerId: "openai",
        providerLabel: "OpenAI",
        title: "Bring your OpenAI API key",
        detail: "Use direct OpenAI API billing.",
        inputKind: .apiKey,
        submitLabel: "Save and Check",
        inputLabel: "OpenAI API key",
        inputHelp: "Paste an OpenAI API key from platform.openai.com.",
        inputPlaceholder: "sk-...",
        methodKind: "api_key")
}

private func subscriptionOptionPayload() -> ConsumerModelsAuthOptionPayload {
    ConsumerModelsAuthOptionPayload(
        id: "openai-codex-oauth",
        providerId: "openai-codex",
        providerLabel: "ChatGPT / Codex",
        title: "Continue with ChatGPT",
        detail: "Use your ChatGPT subscription. Best early-tester path for coding tasks.",
        inputKind: .none,
        submitLabel: "Continue",
        inputLabel: nil,
        inputHelp: nil,
        inputPlaceholder: nil,
        methodKind: "oauth")
}

private func claudeSubscriptionOptionPayload() -> ConsumerModelsAuthOptionPayload {
    ConsumerModelsAuthOptionPayload(
        id: "anthropic-claude-cli",
        providerId: "anthropic",
        providerLabel: "Claude",
        title: "Continue with Claude",
        detail: "Reuses the Claude sign-in already available on this Mac.",
        inputKind: .none,
        submitLabel: "Continue",
        inputLabel: nil,
        inputHelp: nil,
        inputPlaceholder: nil,
        methodKind: "oauth")
}

private func claudeSetupTokenOptionPayload() -> ConsumerModelsAuthOptionPayload {
    ConsumerModelsAuthOptionPayload(
        id: "anthropic-setup-token",
        providerId: "anthropic",
        providerLabel: "Claude",
        title: "Paste Claude setup token",
        detail: "Use your Claude subscription with a setup token.",
        inputKind: .token,
        submitLabel: "Save and Check",
        inputLabel: "Anthropic setup-token",
        inputHelp: "Generate it with `claude setup-token` on any machine.",
        inputPlaceholder: "sk-ant-...",
        methodKind: "token")
}

private func curatedModelsPayload(
    currentModel: String = "openai-codex/gpt-5.4",
    options: [ConsumerSelectableModel] = [
        .init(id: "openai-codex/gpt-5.4", title: "GPT-5.4", detail: "Default ChatGPT / Codex path for early testers."),
        .init(id: "openai-codex/gpt-5.3-codex", title: "Codex 5.3", detail: "Codex-focused model for coding-heavy work."),
    ]) -> ConsumerModelsModelListPayload
{
    ConsumerModelsModelListPayload(
        currentModel: currentModel,
        options: options)
}

private final class SendableCounter: @unchecked Sendable {
    var value = 0
}

@Suite(.serialized)
@MainActor
struct ConsumerSetupReadinessTests {
    @Test func `consumer model readiness marks ready after live gateway probe`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                readyReadinessPayload()
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.isComplete)
        #expect(model.phase == .ready("openai-codex/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.4.")
        #expect(model.authSectionExpanded == false)
        #expect(model.modelOptions.map(\.id) == ["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex"])
        #expect(model.selectedModelId == "openai-codex/gpt-5.4")
    }

    @Test func `consumer model readiness surfaces blocked live probe summary`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(!model.isComplete)
        #expect(model.phase == .failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))
        #expect(model.statusLine == "OpenClaw-managed AI is configured, but the shared auth is no longer usable.")
        #expect(model.authSectionExpanded)
    }

    @Test func `consumer model loads auth options only once after blocked readiness`() async {
        let authLoads = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                authLoads.value += 1
                return ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()
        await model.refresh()

        #expect(authLoads.value == 1)
        #expect(model.authOptions.count == 1)
        #expect(model.selectedOptionId == "openai-api-key")
    }

    @Test func `consumer model rechecks stale failure on app activation`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                return probeCalls.value == 1 ? blockedReadinessPayload() : readyReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()
        #expect(model.phase == .failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))

        await model.refreshOnAppActivationIfNeeded()

        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.4.")
    }

    @Test func `consumer model refreshIfNeeded retries after transient failure`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                if probeCalls.value == 1 {
                    throw NSError(
                        domain: "test",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "consumer control endpoint timed out"])
                }
                return readyReadinessPayload()
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refreshIfNeeded()
        #expect(model.phase == .failed("consumer control endpoint timed out"))

        await model.refreshIfNeeded()

        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.4.")
    }

    @Test func `consumer model apply auth consumes returned readiness and marks ready`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            },
            applyAuth: { optionId, secret in
                #expect(optionId == "openai-api-key")
                #expect(secret == "sk-test")
                return ConsumerModelsAuthApplyPayload(
                    optionId: optionId,
                    providerId: "openai",
                    methodId: "api-key",
                    defaultModel: "openai/gpt-5.4",
                    notes: ["Saved local tester credential."],
                    profileIds: ["openai:default"],
                    readiness: ConsumerModelsReadinessPayload(
                        status: "ready",
                        defaultModel: "openai/gpt-5.4",
                        summary: "AI ready on openai/gpt-5.4.",
                        reasonCodes: []))
            },
            listModels: {
                curatedModelsPayload(
                    currentModel: "openai/gpt-5.4",
                    options: [
                        .init(id: "openai/gpt-5.4", title: "GPT-5.4 (API)", detail: "Direct OpenAI API path when you are using an API key."),
                        .init(id: "openai-codex/gpt-5.3-codex", title: "Codex 5.3", detail: "Codex-focused model for coding-heavy work."),
                    ])
            })

        await model.refresh()
        model.draftSecret = "sk-test"
        await model.submitSelectedAuth()

        #expect(model.isComplete)
        #expect(model.phase == .ready("openai/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai/gpt-5.4.")
        #expect(model.authNotes == ["Saved local tester credential."])
        #expect(model.draftSecret.isEmpty)
        #expect(model.modelOptions.map(\.id) == ["openai/gpt-5.4", "openai-codex/gpt-5.3-codex"])
        #expect(model.selectedModelId == "openai/gpt-5.4")
    }

    @Test func `consumer model apply auth failure keeps blocker and surfaces auth error`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            },
            applyAuth: { _, _ in
                throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad key"])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()
        model.draftSecret = "sk-test"
        await model.submitSelectedAuth()

        #expect(!model.isComplete)
        #expect(model.phase == ConsumerModelSetupModel.Phase.failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))
        #expect(model.authError == "bad key")
    }

    @Test func `consumer model rewrites raw gateway connect errors into startup guidance`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                throw NSError(
                    domain: "gateway",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey: "gateway connect: connect to gateway @ ws://127.0.0.1:21068: Could not connect to the server.",
                    ])
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()])
            })

        await model.refresh()

        #expect(
            model.phase
                == .failed(
                    "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again."))
        #expect(
            model.statusLine
                == "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again.")
    }

    @Test func `consumer model groups auth options by subscription and api key`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [subscriptionOptionPayload(), authOptionPayload()])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.availableAuthCategories == [.subscription, .apiKey])
        #expect(model.authCategory == .subscription)
        #expect(model.visibleAuthOptions.map(\.id) == ["openai-codex-oauth"])

        model.selectAuthCategory(.apiKey)

        #expect(model.selectedOptionId == "openai-api-key")
        #expect(model.visibleAuthOptions.map(\.id) == ["openai-api-key"])
    }

    @Test func `consumer model dedupes provider picker and keeps Claude alternates secondary`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [
                    subscriptionOptionPayload(),
                    claudeSubscriptionOptionPayload(),
                    claudeSetupTokenOptionPayload(),
                ])
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.visibleAuthProviders.map(\.id) == ["openai-codex", "anthropic"])
        #expect(model.visibleAuthProviders.map(\.label) == ["ChatGPT / Codex", "Claude"])

        model.selectProvider("anthropic")

        #expect(model.selectedOptionId == "anthropic-claude-cli")
        #expect(model.selectedProviderOptions.map(\.id) == ["anthropic-claude-cli", "anthropic-setup-token"])
        #expect(model.selectedAlternateAuthOptions.map(\.id) == ["anthropic-setup-token"])

        model.selectOption("anthropic-setup-token")

        #expect(model.selectedProviderId == "anthropic")
        #expect(model.selectedAlternateAuthOptions.map(\.id) == ["anthropic-claude-cli"])
    }

    @Test func `consumer model applies a curated selection and reruns readiness`() async {
        let selectedModels = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                selectedModels.value == 0
                    ? readyReadinessPayload()
                    : ConsumerModelsReadinessPayload(
                        status: "ready",
                        defaultModel: "openai-codex/gpt-5.3-codex",
                        summary: "AI ready on openai-codex/gpt-5.3-codex.",
                        reasonCodes: [])
            },
            listModels: {
                selectedModels.value == 0
                    ? curatedModelsPayload()
                    : curatedModelsPayload(currentModel: "openai-codex/gpt-5.3-codex")
            },
            applyModel: { modelId in
                #expect(modelId == "openai-codex/gpt-5.3-codex")
                selectedModels.value += 1
                return ConsumerModelsSetPayload(ok: true, model: modelId)
            })

        await model.refresh()
        model.selectedModelId = "openai-codex/gpt-5.3-codex"
        await model.submitSelectedModel()

        #expect(selectedModels.value == 1)
        #expect(model.phase == .ready("openai-codex/gpt-5.3-codex"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.3-codex.")
        #expect(model.activeModelId == "openai-codex/gpt-5.3-codex")
    }

    @Test func `consumer auth option input kind decodes api key correctly`() throws {
        let data = """
        {
          "id": "openai-api-key",
          "providerId": "openai",
          "providerLabel": "OpenAI",
          "title": "Bring your OpenAI API key",
          "detail": "Use direct OpenAI API billing.",
          "inputKind": "api_key",
          "submitLabel": "Save and Check",
          "inputLabel": "OpenAI API key",
          "inputHelp": "Paste an OpenAI API key from platform.openai.com.",
          "inputPlaceholder": "sk-...",
          "methodKind": "api_key"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(ConsumerModelsAuthOptionPayload.self, from: data)
        #expect(decoded.inputKind == ConsumerModelsAuthOptionPayload.InputKind.apiKey)
    }
}
