#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CLOSEOUT_SIGNALS = [
  /\b(?:completed|finished|done)\b/i,
  /\bblocked\b/i,
  /\b(?:merged|closed)\b/i,
  /\b(?:handed off|handoff|new owner|ownership moved)\b/i,
  /\b(?:safe to archive|archive this chat|keep this chat open)\b/i,
  /\b(?:remaining work|what remains|next steps?|follow-?up)\b/i,
];
const UNAMBIGUOUS_TERMINAL_SIGNAL =
  /(?:^|[.!?]\s+)(?:the\s+)?(?:(?:work|task|implementation|investigation|release|fix|pr|pull request)\s+(?:is|was|has been)\s+)?(?:completed|finished|done|blocked|merged|closed)(?:\b|\s+pending\b)|\b(?:handed off|ownership moved|safe to archive|archive this chat|keep this chat open)\b/i;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasReceipt(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  return /(?:^|\n)Outcome:[ \t]*(\S[^\n]*)\nRemaining:[ \t]*(\S[^\n]*)\nOwner:[ \t]*(\S[^\n]*)\nNext action:[ \t]*(\S[^\n]*)[ \t]*$/.test(
    normalized,
  );
}

function hasPlainLanguageLead(text) {
  const firstBlock = text.trim().split(/\n\s*\n/, 1)[0] ?? "";
  const firstBlockWords = firstBlock.split(/\s+/).filter(Boolean).length;
  return (
    /^(?:plain language|bottom line|in short|the result|the practical answer|tl;dr)\b/i.test(
      firstBlock,
    ) ||
    (firstBlockWords >= 10 && firstBlockWords <= 80)
  );
}

export function evaluateStopHook(input) {
  // Codex sets this flag on the revision pass. Always allow that pass so a bad
  // model rewrite cannot create an infinite hook/model loop.
  if (input?.stop_hook_active === true) {
    return {};
  }

  const text =
    typeof input?.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (!text.trim()) {
    return {};
  }

  const signalCount = CLOSEOUT_SIGNALS.filter((pattern) => pattern.test(text)).length;
  const needsReceipt =
    (signalCount >= 2 || UNAMBIGUOUS_TERMINAL_SIGNAL.test(text)) && !hasReceipt(text);
  const needsPlainLead = wordCount(text) >= 500 && !hasPlainLanguageLead(text);
  if (!needsReceipt && !needsPlainLead) {
    return {};
  }

  const requests = [];
  if (needsPlainLead) {
    requests.push(
      "Add a short plain-language lead that states the practical result. Preserve the complete technical body, evidence, caveats, and exact proof boundaries; do not replace it with a TLDR.",
    );
  }
  if (needsReceipt) {
    requests.push(
      "End with exactly four plain-text fields: Outcome, Remaining, Owner, and Next action. Use None when appropriate. Never recommend archive while remaining work has no verified owner.",
    );
  }
  return {
    decision: "block",
    reason: `Revise the same final answer once. ${requests.join(" ")}`,
  };
}

async function main() {
  const raw = fs.readFileSync(0, "utf8");
  const input = raw.trim() ? JSON.parse(raw) : {};
  process.stdout.write(JSON.stringify(evaluateStopHook(input)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
