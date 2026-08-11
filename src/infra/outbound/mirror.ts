export type OutboundMirror = {
  sessionKey: string;
  agentId?: string;
  /** Optional non-default session store used by isolated runtimes and tests. */
  storePath?: string;
  /** Refuse to append if the session mapping no longer points at this locked transcript. */
  expectedSessionFile?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
};

export type DeliveryMirror = OutboundMirror & {
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
};
