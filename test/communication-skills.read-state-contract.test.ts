import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSkill(name: string): string {
  return readFileSync(path.join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("cross-channel read-state lifecycle", () => {
  const triageSkill = readSkill("cross-channel-triage");

  it("keeps inspection observational and changes state only after resolution", () => {
    expect(triageSkill).toContain("## Read-State Lifecycle");
    expect(triageSkill).toMatch(
      /Inspecting, shortlisting, previewing, or deep-reading[\s\S]*must not change/,
    );
    expect(triageSkill).toContain("Once an item is genuinely handled, mark it read");
    expect(triageSkill).toContain("approved reply was sent");
    expect(triageSkill).toContain("explicitly skipped");
    expect(triageSkill).toContain("classified it as no action");
  });

  it("preserves pending work and refuses ambiguous bulk mutations", () => {
    expect(triageSkill).toMatch(
      /pending or deferred[\s\S]*preserve its unread state or mark it unread/,
    );
    expect(triageSkill).toContain("Obey explicit user choices");
    expect(triageSkill).toContain("Do not bulk-change ambiguous items");
    expect(triageSkill).toContain("Report unsupported or failed state changes");
  });

  it("allows reversible bookkeeping without weakening risky-action approvals", () => {
    expect(triageSkill).toMatch(/do not need separate approval[\s\S]*authorized triage flow/);
    expect(triageSkill).toMatch(/Existing[\s\S]*approval requirements still apply/);
    for (const riskyAction of ["sends", "deletes", "archives", "purchases", "calendar changes"]) {
      expect(triageSkill).toContain(riskyAction);
    }
  });

  it("keeps lifecycle policy in triage while routing post-send state through channel skills", () => {
    const draftingSkill = readSkill("message-drafting");

    expect(draftingSkill).not.toContain("Read-State Lifecycle");
    expect(draftingSkill).not.toContain("mark-read");
    expect(draftingSkill).not.toContain("mark-unread");
    expect(draftingSkill).toContain("## Post-Send Conversation State");
    expect(draftingSkill).toContain("channel skill's post-send conversation-state rule");
    expect(draftingSkill).toContain("send receipt and conversation-state receipt separate");
    expect(draftingSkill).toContain("never retry the already-sent message");
  });
});

describe("channel skills expose truthful read-state commands", () => {
  it("documents explicit Telegram chat state without claiming reads mutate it", () => {
    const skill = readSkill("telegram-user");

    expect(skill).toContain("Reading with `read --chat` does not itself mark");
    expect(skill).toContain("A successful `send` marks its resolved chat read automatically");
    expect(skill).toContain("openclaw telegram-user mark-read --chat <chat> --json");
    expect(skill).toContain("openclaw telegram-user mark-unread --chat <chat> --json");
    expect(skill).toContain("chat-level state");
    expect(skill).toContain("dialog reminder flag only");
    expect(skill).toContain("cannot revoke a Telegram");
  });

  it("documents WhatsApp chat-level state", () => {
    const skill = readSkill("wacli");

    expect(skill).toContain(
      "After every accepted safe-send, the helper marks the exact resolved chat read",
    );
    expect(skill).toContain("readState.status=marked");
    expect(skill).toContain("wacli chats mark-read --chat <target> --json");
    expect(skill).toContain("wacli chats mark-unread --chat <target> --json");
    expect(skill).toContain("chat-level, not per-message");
    expect(skill).toContain("synced chat app-state");
    expect(skill).toContain("not sender-facing");
  });

  it("uses Gmail message IDs and distinguishes them from thread IDs", () => {
    const skill = readSkill("gog");

    expect(skill).toContain("gog gmail mark-read <messageId>");
    expect(skill).toContain("gog gmail unread <messageId>");
    expect(skill).toContain("message-level results");
    expect(skill).toContain("do not pass a");
    expect(skill).toContain("thread ID");
  });

  it("maps Himalaya seen flags within an explicit account and folder", () => {
    const skill = readSkill("himalaya");

    expect(skill).toContain("pass the verified");
    expect(skill).toContain("--source-folder <folder> --source-envelope-id <id>");
    expect(skill).toContain("marks only those explicit source envelopes `seen` after a clean");
    expect(skill).toContain("Normal `himalaya message read <id>` automatically adds");
    expect(skill).toContain("himalaya message read --preview <id>");
    expect(skill).toContain("himalaya envelope list not flag seen");
    expect(skill).toContain("himalaya flag add <id> seen");
    expect(skill).toContain("himalaya flag remove <id> seen");
    expect(skill).toContain("--account <account> --folder <folder>");
    expect(skill).toContain("Envelope IDs are scoped");
  });
});
