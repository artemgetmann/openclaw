import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateStopHook } from "./codex-response-closeout-hook.mjs";

void test("allows ordinary and already-receipted answers", () => {
  assert.deepEqual(evaluateStopHook({ last_assistant_message: "Here is the answer." }), {});
  assert.deepEqual(
    evaluateStopHook({
      last_assistant_message:
        "Done and merged.\nOutcome: PR merged\nRemaining: None\nOwner: This chat\nNext action: None",
    }),
    {},
  );
});

void test("requests one receipt revision for a likely closeout", () => {
  const result = evaluateStopHook({
    last_assistant_message: "Done. The PR merged. Follow-up work remains.",
  });
  assert.equal(result.decision, "block");
  assert.match(result.reason, /Outcome, Remaining, Owner, and Next action/);
});

void test("rejects malformed or empty closeout fields", () => {
  for (const last_assistant_message of [
    "Done and merged. Outcome: PR merged Remaining: None Owner: This chat Next action: None",
    "Done and merged.\nOutcome: PR merged\nRemaining:\nOwner: This chat\nNext action: None",
    "Done and merged.\nOwner: This chat\nOutcome: PR merged\nRemaining: None\nNext action: None",
  ]) {
    const result = evaluateStopHook({ last_assistant_message });
    assert.equal(result.decision, "block");
  }
});

void test("requests receipts for single-signal blocked and finished closeouts", () => {
  for (const last_assistant_message of ["Blocked pending approval.", "The work is finished."]) {
    const result = evaluateStopHook({ last_assistant_message });
    assert.equal(result.decision, "block");
  }
});

void test("requests a plain-language lead without deleting technical detail", () => {
  const result = evaluateStopHook({
    last_assistant_message: `Architecture\n\n${"technical detail ".repeat(510)}`,
  });
  assert.equal(result.decision, "block");
  assert.match(result.reason, /Preserve the complete technical body/);
  assert.match(result.reason, /do not replace it with a TLDR/);
});

void test("allows the revision pass to prevent loops", () => {
  assert.deepEqual(
    evaluateStopHook({
      stop_hook_active: true,
      last_assistant_message: "Done. The PR merged. Follow-up work remains.",
    }),
    {},
  );
});
