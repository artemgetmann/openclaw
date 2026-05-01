import Foundation
import Testing
@testable import OpenClaw

private func blockedReadinessPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "blocked",
        defaultModel: "openai-codex/gpt-5.5",
        summary: "OpenClaw-managed AI is configured, but the shared auth is no longer usable.",
        reasonCodes: ["probe_auth_failed"])
}

private func authMissingReadinessPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "blocked",
        defaultModel: "openai-codex/gpt-5.5",
        summary: "OpenClaw-managed AI is selected, but the canonical shared auth profile is missing from this consumer runtime.",
        reasonCodes: ["missing_auth"])
}

private func refreshTokenReusedPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "blocked",
        defaultModel: "openai-codex/gpt-5.5",
        summary: "ChatGPT sign-in expired for this Mac (refresh_token_reused). Sign in again to continue.",
        reasonCodes: ["probe_auth_failed"])
}

private func readinessFailedPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "blocked",
        defaultModel: "openai-codex/gpt-5.5",
        summary: "OpenClaw-managed AI did not answer the readiness probe in time.",
        reasonCodes: ["probe_timeout"])
}

private func readyReadinessPayload() -> ConsumerModelsReadinessPayload {
    ConsumerModelsReadinessPayload(
        status: "ready",
        defaultModel: "openai-codex/gpt-5.5",
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

private func claudeApiKeyOptionPayload() -> ConsumerModelsAuthOptionPayload {
    ConsumerModelsAuthOptionPayload(
        id: "anthropic-api-key",
        providerId: "anthropic",
        providerLabel: "Claude",
        title: "Bring your Anthropic API key",
        detail: "Use direct Anthropic API billing.",
        inputKind: .apiKey,
        submitLabel: "Save and Check",
        inputLabel: "Anthropic API key",
        inputHelp: "Paste an Anthropic API key from console.anthropic.com.",
        inputPlaceholder: "sk-ant-...",
        methodKind: "api_key")
}

private func curatedModelsPayload(
    currentModel: String = "openai-codex/gpt-5.5",
    options: [ConsumerSelectableModel] = [
        .init(id: "openai-codex/gpt-5.5", title: "GPT-5.5", detail: "Primary ChatGPT / Codex path for consumer managed AI."),
        .init(id: "openai-codex/gpt-5.4", title: "GPT-5.4", detail: "Practical Codex fallback when GPT-5.5 is not available."),
        .init(id: "openai-codex/gpt-5.4-mini", title: "GPT-5.4 Mini", detail: "Smaller Codex option, shown only when the runtime catalog exposes it."),
        .init(id: "openai-codex/gpt-5.3-codex-spark", title: "GPT-5.3 Codex Spark", detail: "Faster Codex variant when the OAuth catalog exposes Spark."),
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
            listAuthOptions: {
                ConsumerModelsAuthListPayload(
                    options: [subscriptionOptionPayload(), authOptionPayload()],
                    activeOptionId: "openai-codex-oauth")
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.isComplete)
        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.5.")
        #expect(model.authSectionExpanded == false)
        #expect(model.authOptionsLoaded)
        #expect(model.selectedOptionId == "openai-codex-oauth")
        #expect(model.activeAccessTitle == "ChatGPT / Codex login")
        #expect(model.modelOptions.map(\.id) == [
            "openai-codex/gpt-5.5",
            "openai-codex/gpt-5.4",
            "openai-codex/gpt-5.4-mini",
            "openai-codex/gpt-5.3-codex-spark",
        ])
        #expect(model.selectedModelId == "openai-codex/gpt-5.5")
    }

    @Test func `consumer model readiness appends voice blocker when speech transcription is not ready`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                ConsumerModelsReadinessPayload(
                    status: "ready",
                    defaultModel: "openai-codex/gpt-5.5",
                    summary: "OpenClaw-managed AI passed a live readiness check for the default model.",
                    reasonCodes: [],
                    voiceStatus: "blocked",
                    voiceSummary: "Voice messages are not ready yet. This consumer runtime needs either the bundled OpenAI speech key or a BYOK OpenAI/Gemini-style API key for transcription.",
                    voiceActions: [
                        "Rebuild/package the consumer app with OPENCLAW_CONSUMER_OPENAI_API_KEY when product policy allows it.",
                    ])
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(
                    options: [subscriptionOptionPayload(), authOptionPayload()],
                    activeOptionId: "openai-codex-oauth")
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(
            model.statusLine
                == "AI ready on openai-codex/gpt-5.5. Voice messages are not ready yet. This consumer runtime needs either the bundled OpenAI speech key or a BYOK OpenAI/Gemini-style API key for transcription.")
    }

    @Test func `consumer model readiness surfaces blocked live probe summary`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(!model.isComplete)
        #expect(model.phase == .failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))
        #expect(model.statusLine == "OpenClaw-managed AI is configured, but the shared auth is no longer usable.")
        #expect(model.authSectionExpanded)
        #expect(model.failureKind == .providerAuthFailed)
        #expect(!model.canRestartOperator)
    }

    @Test func `consumer model readiness surfaces missing auth as provider auth failure`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                authMissingReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.failureKind == .providerAuthFailed)
        #expect(model.phase == .failed("OpenClaw-managed AI is selected, but the canonical shared auth profile is missing from this consumer runtime."))
        #expect(!model.canRestartOperator)
    }

    @Test func `consumer model readiness surfaces readiness failures as restartable`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                readinessFailedPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()

        #expect(model.failureKind == .readinessFailed)
        #expect(model.phase == .failed("OpenClaw-managed AI did not answer the readiness probe in time."))
        #expect(model.canRestartOperator)
    }

    @Test func `consumer model loads auth options only once after blocked readiness`() async {
        let authLoads = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                authLoads.value += 1
                return ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
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
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()
        #expect(model.phase == .failed("OpenClaw-managed AI is configured, but the shared auth is no longer usable."))

        await model.refreshOnAppActivationIfNeeded()

        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.5.")
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
        #expect(
            model.phase
                == .failed(
                    "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again."))

        await model.refreshIfNeeded()

        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.5.")
    }

    @Test func `consumer model apply auth consumes returned readiness and marks ready`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                return probeCalls.value == 1
                    ? blockedReadinessPayload()
                    : ConsumerModelsReadinessPayload(
                        status: "ready",
                        defaultModel: "openai/gpt-5.4",
                        summary: "AI ready on openai/gpt-5.4.",
                        reasonCodes: [])
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
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
                        .init(id: "openai-codex/gpt-5.4-mini", title: "GPT-5.4 Mini", detail: "Smaller Codex option, shown only when the runtime catalog exposes it."),
                    ])
            })

        await model.refresh()
        model.draftSecret = "sk-test"
        await model.submitSelectedAuth()

        #expect(probeCalls.value == 2)
        #expect(model.isComplete)
        #expect(model.phase == .ready("openai/gpt-5.4"))
        #expect(model.statusLine == "AI ready on openai/gpt-5.4.")
        #expect(model.authNotes == ["Saved local tester credential."])
        #expect(model.draftSecret.isEmpty)
        #expect(model.modelOptions.map(\.id) == ["openai/gpt-5.4", "openai-codex/gpt-5.4-mini"])
        #expect(model.selectedModelId == "openai/gpt-5.4")
    }

    @Test func `consumer model keeps reconnecting after auth apply when gateway stays unreachable`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                if probeCalls.value == 1 {
                    return blockedReadinessPayload()
                }
                throw NSError(
                    domain: "gateway",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey: "gateway connect: connect to gateway @ ws://127.0.0.1:21068: Could not connect to the server.",
                    ])
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [subscriptionOptionPayload()], activeOptionId: nil)
            },
            applyAuth: { optionId, _ in
                #expect(optionId == "openai-codex-oauth")
                return ConsumerModelsAuthApplyPayload(
                    optionId: optionId,
                    providerId: "openai-codex",
                    methodId: "oauth",
                    defaultModel: "openai-codex/gpt-5.5",
                    notes: ["Opened the ChatGPT sign-in flow."],
                    profileIds: ["openai-codex:default"],
                    readiness: readyReadinessPayload())
            },
            listModels: {
                curatedModelsPayload()
            },
            postAuthReconnectProbeDelaysMs: [0, 0, 0, 0])

        await model.refresh()
        await model.submitSelectedAuth()

        #expect(probeCalls.value == 5)
        #expect(model.phase == .checking)
        #expect(model.statusLine == "Reconnecting AI operator after sign-in…")
        #expect(model.failureKind == nil)
        #expect(!model.isComplete)
    }

    @Test func `consumer model apply auth re-probes after restart churn and routes reused token to reauth`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                if probeCalls.value == 1 {
                    return blockedReadinessPayload()
                }
                if probeCalls.value == 2 {
                    throw NSError(
                        domain: "gateway",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "gateway receive: The operation couldn't be completed. Socket is not connected"])
                }
                return refreshTokenReusedPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [subscriptionOptionPayload()], activeOptionId: nil)
            },
            applyAuth: { optionId, _ in
                #expect(optionId == "openai-codex-oauth")
                return ConsumerModelsAuthApplyPayload(
                    optionId: optionId,
                    providerId: "openai-codex",
                    methodId: "oauth",
                    defaultModel: "openai-codex/gpt-5.5",
                    notes: ["Opened the ChatGPT sign-in flow."],
                    profileIds: ["openai-codex:default"],
                    readiness: readyReadinessPayload())
            },
            listModels: {
                curatedModelsPayload()
            })

        await model.refresh()
        await model.submitSelectedAuth()

        #expect(probeCalls.value == 3)
        #expect(!model.isComplete)
        #expect(model.failureKind == .providerAuthFailed)
        #expect(model.phase == .failed("ChatGPT sign-in expired for this Mac (refresh_token_reused). Sign in again to continue."))
        #expect(model.statusLine == "ChatGPT sign-in expired for this Mac (refresh_token_reused). Sign in again to continue.")
        #expect(model.authNotes == ["Opened the ChatGPT sign-in flow."])
        #expect(model.modelOptions.isEmpty)
    }

    @Test func `consumer model apply auth failure keeps blocker and surfaces auth error`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
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
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            })

        await model.refresh()

        #expect(
            model.phase
                == .failed(
                    "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again."))
        #expect(
            model.statusLine
                == "OpenClaw could not reach the local consumer gateway yet. This is a local runtime/startup issue, not an AI account issue. Start or resume the operator, wait a moment, then try again.")
        #expect(model.failureKind == .gatewayUnreachable)
        #expect(model.canRestartOperator)
    }

    @Test func `consumer model groups auth options by subscription and api key`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                blockedReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(
                    options: [subscriptionOptionPayload(), authOptionPayload()],
                    activeOptionId: nil)
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
                ], activeOptionId: nil)
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

    @Test func `consumer model reflects anthropic api key as active access when readiness says api key`() async {
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                ConsumerModelsReadinessPayload(
                    status: "ready",
                    defaultModel: "anthropic/claude-sonnet-4-6",
                    summary: "AI ready on anthropic/claude-sonnet-4-6.",
                    reasonCodes: [],
                    mode: "byok",
                    authMode: "byok",
                    sharedProfileId: nil,
                    probe: ConsumerModelsReadinessProbePayload(
                        provider: "anthropic",
                        model: "anthropic/claude-sonnet-4-6",
                        profileId: "anthropic:api",
                        label: "anthropic:api",
                        source: "profile",
                        mode: "api_key",
                        status: "ok"))
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [
                    claudeSubscriptionOptionPayload(),
                    claudeSetupTokenOptionPayload(),
                    claudeApiKeyOptionPayload(),
                ], activeOptionId: "anthropic-api-key")
            },
            listModels: {
                ConsumerModelsModelListPayload(
                    currentModel: "anthropic/claude-sonnet-4-6",
                    options: [
                        .init(id: "anthropic/claude-sonnet-4-6", title: "Claude Sonnet 4.6", detail: "Balanced Claude default for day-to-day use."),
                    ])
            })

        await model.refresh()

        #expect(model.selectedOptionId == "anthropic-api-key")
        #expect(model.authCategory == .apiKey)
        #expect(model.activeAccessTitle == "Claude API key")
        #expect(model.activeAccessDetail == "Uses a tester-owned API key for this runtime.")
    }

    @Test func `consumer model applies a curated selection and reruns readiness`() async {
        let selectedModels = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                selectedModels.value == 0
                    ? readyReadinessPayload()
                    : ConsumerModelsReadinessPayload(
                        status: "ready",
                        defaultModel: "openai-codex/gpt-5.4-mini",
                        summary: "AI ready on openai-codex/gpt-5.4-mini.",
                        reasonCodes: [])
            },
            listModels: {
                selectedModels.value == 0
                    ? curatedModelsPayload()
                    : curatedModelsPayload(currentModel: "openai-codex/gpt-5.4-mini")
            },
            applyModel: { modelId in
                #expect(modelId == "openai-codex/gpt-5.4-mini")
                selectedModels.value += 1
                return ConsumerModelsSetPayload(ok: true, model: modelId)
            })

        await model.refresh()
        model.selectedModelId = "openai-codex/gpt-5.4-mini"
        await model.submitSelectedModel()

        #expect(selectedModels.value == 1)
        #expect(model.phase == .ready("openai-codex/gpt-5.4-mini"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.4-mini.")
        #expect(model.activeModelId == "openai-codex/gpt-5.4-mini")
    }

    @Test func `consumer model clears stale ready state when model save races gateway restart`() async {
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                return readyReadinessPayload()
            },
            listModels: {
                curatedModelsPayload()
            },
            applyModel: { _ in
                throw NSError(
                    domain: "gateway",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "gateway receive: The operation couldn't be completed. Socket is not connected"])
            })

        await model.refresh()
        model.selectedModelId = "openai-codex/gpt-5.4-mini"
        await model.submitSelectedModel()

        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.5.")
        #expect(model.modelError == nil)
        #expect(model.failureKind == nil)
    }

    @Test func `consumer model restart operator retries readiness and recovers`() async {
        let restartCalls = SendableCounter()
        let probeCalls = SendableCounter()
        let model = ConsumerModelSetupModel(
            probeReadiness: {
                probeCalls.value += 1
                if probeCalls.value == 1 {
                    return readinessFailedPayload()
                }
                return readyReadinessPayload()
            },
            listAuthOptions: {
                ConsumerModelsAuthListPayload(options: [authOptionPayload()], activeOptionId: nil)
            },
            listModels: {
                curatedModelsPayload()
            },
            restartGateway: {
                restartCalls.value += 1
            })

        await model.refresh()
        #expect(model.failureKind == .readinessFailed)
        #expect(model.canRestartOperator)

        await model.restartOperator()

        #expect(restartCalls.value == 1)
        #expect(probeCalls.value == 2)
        #expect(model.phase == .ready("openai-codex/gpt-5.5"))
        #expect(model.failureKind == nil)
        #expect(model.statusLine == "AI ready on openai-codex/gpt-5.5.")
        #expect(!model.canRestartOperator)
        #expect(!model.isRestartingOperator)
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
