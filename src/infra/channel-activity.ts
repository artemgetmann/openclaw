import type { ChannelId } from "../channels/plugins/types.js";
export type ChannelDirection = "inbound" | "outbound";

type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};

type ChannelActivityGlobal = {
  activity: Map<string, ActivityEntry>;
};

const CHANNEL_ACTIVITY_GLOBAL_KEY = Symbol.for("openclaw.channelActivity.v1");

function resolveActivityStore(): Map<string, ActivityEntry> {
  const root = globalThis as typeof globalThis & {
    [CHANNEL_ACTIVITY_GLOBAL_KEY]?: ChannelActivityGlobal;
  };
  root[CHANNEL_ACTIVITY_GLOBAL_KEY] ??= { activity: new Map<string, ActivityEntry>() };
  return root[CHANNEL_ACTIVITY_GLOBAL_KEY].activity;
}

// The runtime bundles channel senders and gateway status handlers into separate
// chunks. Keep activity on process-global state so both chunks observe the same
// inbound/outbound timestamps.
const activity = resolveActivityStore();

function keyFor(channel: ChannelId, accountId: string) {
  return `${channel}:${accountId || "default"}`;
}

function ensureEntry(channel: ChannelId, accountId: string): ActivityEntry {
  const key = keyFor(channel, accountId);
  const existing = activity.get(key);
  if (existing) {
    return existing;
  }
  const created: ActivityEntry = { inboundAt: null, outboundAt: null };
  activity.set(key, created);
  return created;
}

export function recordChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
  direction: ChannelDirection;
  at?: number;
}) {
  const at = typeof params.at === "number" ? params.at : Date.now();
  const accountId = params.accountId?.trim() || "default";
  const entry = ensureEntry(params.channel, accountId);
  if (params.direction === "inbound") {
    entry.inboundAt = at;
  }
  if (params.direction === "outbound") {
    entry.outboundAt = at;
  }
}

export function getChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
}): ActivityEntry {
  const accountId = params.accountId?.trim() || "default";
  return (
    activity.get(keyFor(params.channel, accountId)) ?? {
      inboundAt: null,
      outboundAt: null,
    }
  );
}

export function resetChannelActivityForTest() {
  activity.clear();
}
