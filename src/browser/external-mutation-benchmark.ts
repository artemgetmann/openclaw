export type ExternalMutationArtifact = {
  text: string;
  mediaIds: string[];
  target: string;
};

export type ExternalMutationComposerState = {
  visibleText: string;
  draftText: string;
  visibleMediaIds: string[];
  draftMediaIds: string[];
  visibleTarget: string;
  draftTarget: string;
};

export type ExternalMutationBenchmarkScenario = {
  id: string;
  description: string;
  expected: ExternalMutationArtifact;
  composer: ExternalMutationComposerState;
};

export type ExternalMutationVerification = {
  ok: boolean;
  missingText: boolean;
  missingMediaIds: string[];
  targetMismatch: boolean;
};

export const EXTERNAL_MUTATION_BENCHMARK_SCENARIOS: ExternalMutationBenchmarkScenario[] = [
  {
    id: "visible-text-stale-draft",
    description: "visible rich-editor text updates while the internal publish payload is stale",
    expected: {
      text: "Shipping browser contracts with an image",
      mediaIds: ["image-1"],
      target: "Build in Public",
    },
    composer: {
      visibleText: "Shipping browser contracts with an image",
      draftText: "",
      visibleMediaIds: ["image-1"],
      draftMediaIds: ["image-1"],
      visibleTarget: "Build in Public",
      draftTarget: "Build in Public",
    },
  },
  {
    id: "media-preview-stale-draft",
    description: "media preview is visible while the internal publish payload omits the media",
    expected: {
      text: "Shipping browser contracts with an image",
      mediaIds: ["image-1"],
      target: "Build in Public",
    },
    composer: {
      visibleText: "Shipping browser contracts with an image",
      draftText: "Shipping browser contracts with an image",
      visibleMediaIds: ["image-1"],
      draftMediaIds: [],
      visibleTarget: "Build in Public",
      draftTarget: "Build in Public",
    },
  },
  {
    id: "destination-drift",
    description: "visible destination stays selected while the internal publish target drifts",
    expected: {
      text: "Shipping browser contracts with an image",
      mediaIds: ["image-1"],
      target: "Build in Public",
    },
    composer: {
      visibleText: "Shipping browser contracts with an image",
      draftText: "Shipping browser contracts with an image",
      visibleMediaIds: ["image-1"],
      draftMediaIds: ["image-1"],
      visibleTarget: "Build in Public",
      draftTarget: "Profile",
    },
  },
  {
    id: "committed-state-matches",
    description: "visible composer state and internal publish payload agree",
    expected: {
      text: "Shipping browser contracts with an image",
      mediaIds: ["image-1"],
      target: "Build in Public",
    },
    composer: {
      visibleText: "Shipping browser contracts with an image",
      draftText: "Shipping browser contracts with an image",
      visibleMediaIds: ["image-1"],
      draftMediaIds: ["image-1"],
      visibleTarget: "Build in Public",
      draftTarget: "Build in Public",
    },
  },
];

export function snapshotVisibleComposer(
  scenario: ExternalMutationBenchmarkScenario,
): ExternalMutationArtifact {
  return {
    text: scenario.composer.visibleText,
    mediaIds: [...scenario.composer.visibleMediaIds],
    target: scenario.composer.visibleTarget,
  };
}

export function publishMockComposer(
  scenario: ExternalMutationBenchmarkScenario,
): ExternalMutationArtifact {
  // The benchmark deliberately publishes from the app-owned draft state, not
  // from visible DOM text/previews. This mirrors rich React composers where DOM
  // appearance can diverge from the payload used by the final commit.
  return {
    text: scenario.composer.draftText,
    mediaIds: [...scenario.composer.draftMediaIds],
    target: scenario.composer.draftTarget,
  };
}

export function verifyFinalArtifact(params: {
  expected: ExternalMutationArtifact;
  artifact: ExternalMutationArtifact;
}): ExternalMutationVerification {
  const missingMediaIds = params.expected.mediaIds.filter(
    (mediaId) => !params.artifact.mediaIds.includes(mediaId),
  );
  const missingText =
    params.expected.text.trim().length > 0 && !params.artifact.text.includes(params.expected.text);
  const targetMismatch = params.artifact.target !== params.expected.target;
  return {
    ok: !missingText && missingMediaIds.length === 0 && !targetMismatch,
    missingText,
    missingMediaIds,
    targetMismatch,
  };
}

export function findExternalMutationScenario(
  id: string,
): ExternalMutationBenchmarkScenario | undefined {
  return EXTERNAL_MUTATION_BENCHMARK_SCENARIOS.find((scenario) => scenario.id === id);
}
