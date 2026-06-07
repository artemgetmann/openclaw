export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  channelData?: Record<string, unknown>;
};
