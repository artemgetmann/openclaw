export type TelegramUserDirectMessagesTopic = {
  topic_id: number | null;
};

export type TelegramUserMessage = {
  chat_id: number | null;
  chat_username: string | null;
  chat_title: string | null;
  date: string | null;
  direct_messages_topic: TelegramUserDirectMessagesTopic | null;
  direct_messages_topic_id: number | null;
  message_id: number;
  out: boolean;
  reply_to_msg_id: number | null;
  reply_to_top_id: number | null;
  sender_id: number | null;
  text: string;
  thread_anchor: number | null;
};

export type TelegramUserPrecheck = {
  chat: {
    chat_id: number | null;
    peer_type: string | null;
    title: string | null;
    username: string | null;
  } | null;
  session_path: string;
  user: {
    first_name: string | null;
    user_id: number;
    username: string | null;
  };
};

export type TelegramUserSendResult = {
  message: TelegramUserMessage;
};

export type TelegramUserReadResult = {
  messages: TelegramUserMessage[];
};

export type TelegramUserBackendError = {
  code: string;
  details?: Record<string, unknown> | null;
  message: string;
};

export type TelegramUserBackendOptions = {
  envFile?: string | null;
  session?: string | null;
};

export type TelegramUserWaitMatchReason =
  | "matched"
  | "empty_text"
  | `sender_mismatch:${string}`
  | "text_mismatch"
  | `thread_mismatch:${string}`
  | `too_old:${string}`;

export type TelegramUserWaitCandidate = TelegramUserMessage & {
  ignored_reason: TelegramUserWaitMatchReason;
};

export type TelegramUserWaitResult = {
  attempts: number;
  elapsed_ms: number;
  ignored_recent: TelegramUserWaitCandidate[];
  matched: TelegramUserMessage;
  matched_by:
    | "direct_messages_topic.topic_id"
    | "no_thread_filter"
    | "reply_to_msg_id"
    | "reply_to_top_id";
};

export type TelegramUserWaitParams = TelegramUserBackendOptions & {
  afterId?: number | null;
  chat: string;
  contains?: string | null;
  limit?: number | null;
  pollIntervalMs?: number | null;
  senderId?: number | null;
  threadAnchor?: number | null;
  timeoutMs?: number | null;
};
