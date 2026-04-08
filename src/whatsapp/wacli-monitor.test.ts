import { describe, expect, it } from "vitest";
import {
  decideWacliMonitorBootstrapAction,
  resolvePreferredMonitorChatJid,
} from "./wacli-monitor.js";
import type { WacliReplyLookupResult } from "./wacli-reconciliation.js";

function createLookupResult(): WacliReplyLookupResult {
  return {
    target: "971552857036@s.whatsapp.net",
    seedJids: ["971552857036@s.whatsapp.net"],
    seedPhones: ["971552857036"],
    identityNames: ["artem"],
    candidates: [
      {
        jid: "74333133234289@lid",
        kind: "unknown",
        name: "Artem",
        lastMessageTs: 1_775_039_860,
        reasons: ["active-inbound-thread", "matching-name"],
        score: 220,
      },
      {
        jid: "971552857036@s.whatsapp.net",
        kind: "dm",
        name: "Artem",
        lastMessageTs: 1_775_039_816,
        reasons: ["exact-jid", "matching-phone"],
        score: 150,
      },
    ],
    latestInboundReply: {
      chatJid: "74333133234289@lid",
      msgId: "inbound-42",
      senderJid: "74333133234289:12@lid",
      ts: 1_775_039_860,
      fromMe: false,
      text: "Need this handled today",
      mediaType: null,
      mediaCaption: null,
      displayText: "Need this handled today",
      chatName: "Artem",
      senderName: "Artem",
      effectiveText: "Need this handled today",
      hasRenderableContent: true,
    },
    preferredMonitorChatJid: "74333133234289@lid",
  };
}

describe("wacli monitor resolution", () => {
  it("pins monitor state to the active inbound sibling thread", () => {
    const lookup = createLookupResult();
    expect(resolvePreferredMonitorChatJid(lookup)).toBe("74333133234289@lid");
  });
});

describe("wacli monitor bootstrap action", () => {
  it("processes the actionable latest message on first run instead of suppressing it", () => {
    const lookup = createLookupResult();
    expect(
      decideWacliMonitorBootstrapAction({
        lookup,
      }),
    ).toEqual({
      action: "process-latest",
      chatJid: "74333133234289@lid",
      msgId: "inbound-42",
      reason: "first-run-actionable-latest",
    });
  });

  it("dedupes only after a message was already processed", () => {
    const lookup = createLookupResult();
    expect(
      decideWacliMonitorBootstrapAction({
        lastProcessedMsgId: "inbound-42",
        lookup,
      }),
    ).toEqual({
      action: "noop",
      chatJid: "74333133234289@lid",
      msgId: "inbound-42",
      reason: "already-processed",
    });
  });
});
