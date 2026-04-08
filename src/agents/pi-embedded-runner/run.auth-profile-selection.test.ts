import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "./run.js";
import {
  mockedGetApiKeyForModel,
  mockedMarkAuthProfileFailure,
  mockedResolveAuthProfileOrder,
} from "./run.overflow-compaction.mocks.shared.js";
import { overflowBaseRunParams as baseParams } from "./run.overflow-compaction.shared-test.js";

describe("runEmbeddedPiAgent auth profile selection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveAuthProfileOrder.mockReturnValue(["openai-codex:notblockedamazon"]);
    mockedGetApiKeyForModel.mockRejectedValue(new Error("refresh_token_reused"));
    vi.mocked(classifyFailoverReason).mockReturnValue("auth_permanent");
  });

  it("marks the selected profile as permanently failed when auth resolution dies before the first attempt", async () => {
    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("refresh_token_reused");

    expect(mockedMarkAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "openai-codex:notblockedamazon",
        reason: "auth_permanent",
      }),
    );
  });
});
