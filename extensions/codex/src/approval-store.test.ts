import { describe, expect, it } from "vitest";
import { CodexApprovalStore } from "./approval-store.js";

describe("CodexApprovalStore", () => {
  it("consumes one-time approval authority before a replay can use it", () => {
    const store = new CodexApprovalStore();
    const issued = store.issue({
      action: "archive",
      threadId: "thread-1",
      requesterSenderId: "owner-1",
    });

    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
        senderId: "owner-1",
      }),
    ).toMatchObject({ action: "archive", threadId: "thread-1" });
    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
        senderId: "owner-1",
      }),
    ).toBeNull();
  });

  it("burns a token when a different sender attempts to use it", () => {
    const store = new CodexApprovalStore();
    const issued = store.issue({
      action: "unarchive",
      threadId: "thread-2",
      requesterSenderId: "owner-1",
    });

    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
        senderId: "other-user",
      }),
    ).toBeNull();
    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
        senderId: "owner-1",
      }),
    ).toBeNull();
  });

  it("burns a sender-bound token when callback identity is missing", () => {
    const store = new CodexApprovalStore();
    const issued = store.issue({
      action: "archive",
      threadId: "thread-3",
      requesterSenderId: "owner-1",
    });

    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
      }),
    ).toBeNull();
    expect(
      store.consume({
        token: issued.token,
        decision: "approve",
        senderId: "owner-1",
      }),
    ).toBeNull();
  });
});
