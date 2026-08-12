import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import {
  extractCloseoutReceipt,
  findLikelyCloseoutSignals,
  recordCloseoutReceipt,
} from "./closeout-receipt.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("closeout receipts", () => {
  it("extracts the strict four-field contract without losing multiple remaining tasks", () => {
    const receipt = extractCloseoutReceipt(
      [
        "Release details above.",
        "Outcome: Jarvis was released and installed",
        "Remaining: automate disk recovery; automate lock recovery",
        "Owner: No owner",
        "Next action: Create one implementation owner",
      ].join("\n"),
      { sessionId: "session-1", now: 123 },
    );

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      outcome: "Jarvis was released and installed",
      remaining: ["automate disk recovery", "automate lock recovery"],
      owner: "No owner",
      nextAction: "Create one implementation owner",
      sourceSessionId: "session-1",
      updatedAt: 123,
    });
    expect(receipt?.sourceTextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not treat terminal-sounding prose as a receipt", () => {
    expect(extractCloseoutReceipt("Done. The PR merged, but follow-up work remains.")).toBeNull();
    expect(findLikelyCloseoutSignals("Done. The PR merged, but follow-up work remains.")).toEqual([
      "completed",
      "merged",
      "remaining-work",
    ]);
  });

  it("rejects a receipt whose Remaining field is empty", () => {
    expect(
      extractCloseoutReceipt("Outcome: PR merged\nRemaining:\nOwner: This chat\nNext action: None"),
    ).toBeNull();
  });

  it("stores an explicit receipt and marks a missing likely closeout for review", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-closeout-receipt-"));
    temporaryDirectories.push(directory);
    const storePath = path.join(directory, "sessions.json");
    await saveSessionStore(storePath, {
      "agent:main:main": { sessionId: "session-1", updatedAt: 1 },
    });

    await recordCloseoutReceipt({
      storePath,
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      now: 10,
      payloads: [
        {
          text: [
            "Outcome: Investigation completed",
            "Remaining: None",
            "Owner: This chat",
            "Next action: None",
          ].join("\n"),
        },
      ],
    });
    let stored = loadSessionStore(storePath, { skipCache: true })["agent:main:main"];
    expect(stored?.closeoutReceipt?.remaining).toEqual([]);
    expect(stored?.closeoutReceiptAudit?.status).toBe("present");

    await recordCloseoutReceipt({
      storePath,
      sessionKey: "agent:main:main",
      now: 20,
      payloads: [{ text: "The task is blocked. Here are the next steps." }],
    });
    stored = loadSessionStore(storePath, { skipCache: true })["agent:main:main"];
    expect(stored?.closeoutReceiptAudit).toMatchObject({
      status: "review-needed",
      signals: ["blocked", "remaining-work"],
      updatedAt: 20,
    });
    // The newer ambiguous closeout supersedes the old ownership state.
    expect(stored?.closeoutReceipt).toBeUndefined();
  });

  it("does not attach a delivered receipt to a replacement session", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-closeout-receipt-"));
    temporaryDirectories.push(directory);
    const storePath = path.join(directory, "sessions.json");
    await saveSessionStore(storePath, {
      "agent:main:main": { sessionId: "replacement-session", updatedAt: 2 },
    });

    const receipt = await recordCloseoutReceipt({
      storePath,
      sessionKey: "agent:main:main",
      sessionId: "original-session",
      payloads: [
        {
          text: [
            "Outcome: Old session completed",
            "Remaining: None",
            "Owner: This chat",
            "Next action: None",
          ].join("\n"),
        },
      ],
    });

    const stored = loadSessionStore(storePath, { skipCache: true })["agent:main:main"];
    expect(receipt).toBeNull();
    expect(stored?.sessionId).toBe("replacement-session");
    expect(stored?.closeoutReceipt).toBeUndefined();
    expect(stored?.closeoutReceiptAudit).toBeUndefined();
  });
});
