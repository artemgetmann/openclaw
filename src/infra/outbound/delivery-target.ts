import type { OutboundChannel } from "./targets.js";

export function normalizeOutboundDeliveryTarget(
  channel: Exclude<OutboundChannel, "none">,
  to: string,
): string {
  if (channel !== "telegram") {
    return to;
  }

  // Older notification and followup paths persisted Telegram's internal
  // session-address form (`group:<chat id>`). The live Telegram transport
  // accepts only the bare negative group chat id. Normalize only this proven
  // legacy shape: a positive numeric ID can name a private recipient, so
  // stripping `group:` there could silently misdeliver instead of failing safe.
  // Leave usernames and every other provider untouched for the same reason.
  const legacyGroup = /^(?:(?:telegram|tg):)?group:(-\d+)$/i.exec(to.trim());
  return legacyGroup?.[1] ?? to;
}
