import { describe, expect, it } from "vitest";
import {
  EXTERNAL_MUTATION_BENCHMARK_SCENARIOS,
  findExternalMutationScenario,
  publishMockComposer,
  snapshotVisibleComposer,
  verifyFinalArtifact,
} from "./external-mutation-benchmark.js";

describe("external mutation benchmark", () => {
  it("contains the local failure modes needed for social composer regression tests", () => {
    expect(EXTERNAL_MUTATION_BENCHMARK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "visible-text-stale-draft",
      "media-preview-stale-draft",
      "destination-drift",
      "committed-state-matches",
    ]);
  });

  it("proves visible composer state is not final artifact proof", () => {
    const scenario = findExternalMutationScenario("visible-text-stale-draft");
    expect(scenario).toBeDefined();
    if (!scenario) {
      return;
    }

    expect(snapshotVisibleComposer(scenario)).toEqual(scenario.expected);
    const finalArtifact = publishMockComposer(scenario);
    expect(verifyFinalArtifact({ expected: scenario.expected, artifact: finalArtifact })).toEqual({
      ok: false,
      missingText: true,
      missingMediaIds: [],
      targetMismatch: false,
    });
  });

  it("fails when media preview is visible but final artifact omits the media", () => {
    const scenario = findExternalMutationScenario("media-preview-stale-draft");
    expect(scenario).toBeDefined();
    if (!scenario) {
      return;
    }

    expect(snapshotVisibleComposer(scenario)).toEqual(scenario.expected);
    const finalArtifact = publishMockComposer(scenario);
    expect(verifyFinalArtifact({ expected: scenario.expected, artifact: finalArtifact })).toEqual({
      ok: false,
      missingText: false,
      missingMediaIds: ["image-1"],
      targetMismatch: false,
    });
  });

  it("fails when the final artifact target drifts from the intended audience", () => {
    const scenario = findExternalMutationScenario("destination-drift");
    expect(scenario).toBeDefined();
    if (!scenario) {
      return;
    }

    expect(snapshotVisibleComposer(scenario)).toEqual(scenario.expected);
    const finalArtifact = publishMockComposer(scenario);
    expect(verifyFinalArtifact({ expected: scenario.expected, artifact: finalArtifact })).toEqual({
      ok: false,
      missingText: false,
      missingMediaIds: [],
      targetMismatch: true,
    });
  });

  it("passes only when the committed final artifact matches text, media, and target", () => {
    const scenario = findExternalMutationScenario("committed-state-matches");
    expect(scenario).toBeDefined();
    if (!scenario) {
      return;
    }

    const finalArtifact = publishMockComposer(scenario);
    expect(verifyFinalArtifact({ expected: scenario.expected, artifact: finalArtifact })).toEqual({
      ok: true,
      missingText: false,
      missingMediaIds: [],
      targetMismatch: false,
    });
  });
});
