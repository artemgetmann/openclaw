import { randomBytes } from "node:crypto";

export type CodexApprovalAction = "archive" | "unarchive";

type PendingApproval = {
  token: string;
  action: CodexApprovalAction;
  threadId: string;
  requesterSenderId?: string;
  expiresAt: number;
};

/**
 * Process-local one-time approval store.
 *
 * Tokens are deleted before mutation begins, so a double-click, callback
 * replay, timeout retry, or failed mutation cannot reuse the same authority.
 * A Gateway restart deliberately expires pending approvals.
 */
export class CodexApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();

  issue(params: {
    action: CodexApprovalAction;
    threadId: string;
    requesterSenderId?: string;
    ttlMs?: number;
  }): PendingApproval {
    const token = randomBytes(9).toString("base64url");
    const approval: PendingApproval = {
      token,
      action: params.action,
      threadId: params.threadId,
      requesterSenderId: params.requesterSenderId?.trim() || undefined,
      expiresAt: Date.now() + (params.ttlMs ?? 5 * 60_000),
    };
    this.pending.set(token, approval);
    return approval;
  }

  consume(params: {
    token: string;
    decision: "approve" | "reject" | "open";
    senderId?: string;
  }): PendingApproval | null {
    const approval = this.pending.get(params.token);
    if (!approval) {
      return null;
    }
    // Consume first. Every terminal decision and every invalid replay burns
    // the token rather than extending authority through error handling.
    this.pending.delete(params.token);
    if (approval.expiresAt <= Date.now()) {
      return null;
    }
    if (approval.requesterSenderId && approval.requesterSenderId !== params.senderId?.trim()) {
      return null;
    }
    return approval;
  }
}
