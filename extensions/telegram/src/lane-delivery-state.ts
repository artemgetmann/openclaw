export type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedSilent: number;
  skippedNonSilent: number;
  failedNonSilent: number;
};

export type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  markSilentSkip: () => void;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedSilent: 0,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markSilentSkip: () => {
      state.skippedSilent += 1;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}
