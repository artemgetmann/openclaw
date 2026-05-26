import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeSimpleUserMessages,
  type SanitizeSessionHistoryHarness,
  sanitizeSnapshotChangedOpenAIReasoning,
  sanitizeWithOpenAIResponses,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

vi.mock("./pi-embedded-helpers.js", async () => {
  const openai = await vi.importActual<typeof import("./pi-embedded-helpers/openai.js")>(
    "./pi-embedded-helpers/openai.js",
  );
  return {
    ...openai,
    isCompactionFailureError: vi.fn(() => false),
    isGoogleModelApi: vi.fn(),
    sanitizeGoogleTurnOrdering: vi.fn((messages) => {
      const first = messages[0] as { role?: unknown } | undefined;
      if (first?.role !== "assistant") {
        return messages;
      }
      return [{ role: "user", content: "(session bootstrap)", timestamp: Date.now() }, ...messages];
    }),
    sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
  };
});

vi.mock("./transcript-policy.js", () => ({
  resolveTranscriptPolicy: (params: {
    modelApi?: string | null;
    provider?: string | null;
    modelId?: string | null;
  }) => {
    const provider = params.provider ?? "";
    const modelApi = params.modelApi ?? "";
    const modelId = params.modelId ?? "";
    const isGoogle = modelApi === "google-gemini-cli" || modelApi === "google-generative-ai";
    const isAnthropic =
      modelApi === "anthropic-messages" ||
      modelApi === "bedrock-converse-stream" ||
      provider === "anthropic" ||
      provider === "amazon-bedrock";
    const isStrictOpenAICompatible = modelApi === "openai-completions" && provider !== "openai";
    const isMistral = modelId.toLowerCase().includes("mistral");
    const isClaudeCopilot = provider === "github-copilot" && modelId.includes("claude");

    return {
      sanitizeMode: isGoogle || isAnthropic || isMistral ? "full" : "images-only",
      sanitizeToolCallIds: modelApi.startsWith("openai") || isGoogle || isAnthropic || isMistral,
      toolCallIdMode: isMistral
        ? "strict9"
        : modelApi.startsWith("openai") || isGoogle || isAnthropic
          ? "strict"
          : undefined,
      repairToolUseResultPairing: true,
      preserveSignatures: false,
      sanitizeThinkingSignatures: false,
      dropThinkingBlocks: isAnthropic || isClaudeCopilot,
      applyGoogleTurnOrdering: isGoogle || isStrictOpenAICompatible,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: isGoogle || isAnthropic,
    };
  },
}));

let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];

describe("sanitizeSessionHistory e2e smoke", () => {
  const mockSessionManager = makeMockSessionManager();
  const mockMessages = makeSimpleUserMessages();

  beforeEach(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });

  it("passes simple user-only history through for google model APIs", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for openai-responses", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("downgrades openai reasoning blocks when the model snapshot changed", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });
});
