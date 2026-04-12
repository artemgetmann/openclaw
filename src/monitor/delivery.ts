import type { CronDelivery } from "../cron/types.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import type { MonitorActionPolicy, MonitorRecord, MonitorSourceTarget } from "./types.js";

export type MonitorDeliveryPromptMode = "summary" | "reply";
export type MonitorExecutionDeliveryContract = "cron-owned" | "shared";

export type MonitorMessageActionTarget = {
  kind: "message";
  channel: string;
  to: string;
  accountId?: string;
};

export type MonitorEmailReplyActionTarget = {
  kind: "email-reply";
  provider: "gmail" | "email";
  accountId?: string;
  threadId: string;
  replyToMessageId: string;
  recipients: {
    to: string[];
    cc?: string[];
    bcc?: string[];
  };
};

export type MonitorActionTarget = MonitorMessageActionTarget | MonitorEmailReplyActionTarget;

export type MonitorExecutionPlan = {
  actionTarget?: MonitorActionTarget;
  originDelivery?: CronDelivery;
  fallbackDelivery?: CronDelivery;
  deliveryPromptMode: MonitorDeliveryPromptMode;
  deliveryContract: MonitorExecutionDeliveryContract;
  watchDeliveryConfigured: boolean;
  messageToolTarget?: MonitorMessageActionTarget;
  requireExplicitMessageTarget: boolean;
};

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSourceTargetTo(sourceTarget: MonitorSourceTarget): string | undefined {
  return (
    readOptionalString(sourceTarget.to) ??
    readOptionalString(sourceTarget.target) ??
    readOptionalString(sourceTarget.chatId) ??
    readOptionalString(sourceTarget.chatJid)
  );
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

function resolveMonitorEmailReplyActionTarget(params: {
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
}): MonitorEmailReplyActionTarget | undefined {
  const provider =
    params.sourceType.trim().toLowerCase() === "gmail"
      ? "gmail"
      : params.sourceType.trim().toLowerCase() === "email"
        ? "email"
        : undefined;
  if (!provider) {
    return undefined;
  }

  const threadId =
    readOptionalString(params.sourceTarget.threadId) ??
    readOptionalString(params.sourceTarget.gmailThreadId);
  const replyToMessageId =
    readOptionalString(params.sourceTarget.replyToMessageId) ??
    readOptionalString(params.sourceTarget.messageId) ??
    readOptionalString(params.sourceTarget.gmailMessageId);
  const to =
    readStringArray(params.sourceTarget.toRecipients) ??
    readStringArray(params.sourceTarget.to) ??
    readStringArray(params.sourceTarget.recipients);

  if (!threadId || !replyToMessageId || !to) {
    return undefined;
  }

  return {
    kind: "email-reply",
    provider,
    accountId:
      readOptionalString(params.sourceTarget.accountId) ??
      readOptionalString(params.sourceTarget.account),
    threadId,
    replyToMessageId,
    recipients: {
      to,
      ...(readStringArray(params.sourceTarget.ccRecipients)
        ? { cc: readStringArray(params.sourceTarget.ccRecipients) }
        : {}),
      ...(readStringArray(params.sourceTarget.bccRecipients)
        ? { bcc: readStringArray(params.sourceTarget.bccRecipients) }
        : {}),
    },
  };
}

export function resolveMonitorWatchDelivery(params: {
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  explicitWatchDelivery?: CronDelivery;
}): CronDelivery | undefined {
  if (params.explicitWatchDelivery) {
    return params.explicitWatchDelivery;
  }

  // Static monitor delivery inference is only safe for watched surfaces whose
  // reply target is a stable `(channel, to, accountId)` tuple. Gmail/email does
  // not fit that shape: a correct reply also needs per-message metadata such as
  // the latest recipient set and reply-to message id. Fail closed here until
  // email monitors grow a real reply-state resolver instead of guessing.
  const channel =
    resolveGatewayMessageChannel(readOptionalString(params.sourceTarget.channel)) ??
    resolveGatewayMessageChannel(params.sourceType);
  const to = readSourceTargetTo(params.sourceTarget);
  const accountId = readOptionalString(params.sourceTarget.accountId);

  if (!channel || !to) {
    return undefined;
  }

  return {
    mode: "announce",
    channel,
    to,
    ...(accountId ? { accountId } : {}),
  };
}

export function resolveMonitorActionTarget(params: {
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  explicitWatchDelivery?: CronDelivery;
}): MonitorActionTarget | undefined {
  const watchDelivery = resolveMonitorWatchDelivery(params);
  if (watchDelivery?.channel && watchDelivery.to) {
    return {
      kind: "message",
      channel: watchDelivery.channel,
      to: watchDelivery.to,
      ...(watchDelivery.accountId ? { accountId: watchDelivery.accountId } : {}),
    };
  }
  return resolveMonitorEmailReplyActionTarget(params);
}

function resolveOriginDelivery(originDelivery: CronDelivery | undefined): CronDelivery | undefined {
  if (!originDelivery) {
    return undefined;
  }
  if (originDelivery.mode === "webhook" || originDelivery.mode === "none") {
    return originDelivery;
  }
  // CLI-origin monitors have no channel/to target. Preserve the durable
  // origin session and skip channel delivery instead of inventing a recipient.
  if (!originDelivery.channel && !originDelivery.to) {
    return undefined;
  }
  return {
    mode: "announce",
    channel: originDelivery.channel,
    to: originDelivery.to,
    accountId: originDelivery.accountId,
  };
}

export function resolveMonitorRunDelivery(params: {
  actionPolicy: MonitorActionPolicy;
  originDelivery?: CronDelivery;
  watchDelivery?: CronDelivery;
}): {
  delivery?: CronDelivery;
  deliveryPromptMode: MonitorDeliveryPromptMode;
  watchDeliveryConfigured: boolean;
} {
  // Translate monitor policy into the concrete runtime delivery contract. The
  // monitor store keeps policy/data; the wake runner needs an actual target.
  const watchDeliveryConfigured = Boolean(params.watchDelivery);
  if (params.actionPolicy === "auto_send" && params.watchDelivery) {
    return {
      delivery: params.watchDelivery,
      deliveryPromptMode: "reply",
      watchDeliveryConfigured,
    };
  }

  return {
    delivery: resolveOriginDelivery(params.originDelivery),
    deliveryPromptMode: "summary",
    watchDeliveryConfigured,
  };
}

export function resolveMonitorExecutionPlan(params: {
  actionPolicy: MonitorActionPolicy;
  sourceType: string;
  sourceTarget: MonitorSourceTarget;
  originDelivery?: CronDelivery;
  watchDelivery?: CronDelivery;
}): MonitorExecutionPlan {
  const actionTarget = resolveMonitorActionTarget({
    sourceType: params.sourceType,
    sourceTarget: params.sourceTarget,
    explicitWatchDelivery: params.watchDelivery,
  });
  const originDelivery = resolveOriginDelivery(params.originDelivery);
  const watchDeliveryConfigured = Boolean(actionTarget ?? params.watchDelivery);

  // Monitor auto-send should behave like a normal turn: the agent gets the
  // message tool plus a concrete watched-surface target, and cron delivery
  // becomes a safety-net only when the wake did not actually send.
  if (params.actionPolicy === "auto_send" && actionTarget?.kind === "message") {
    return {
      actionTarget,
      originDelivery,
      fallbackDelivery: params.watchDelivery,
      deliveryPromptMode: "reply",
      deliveryContract: "shared",
      watchDeliveryConfigured,
      messageToolTarget: actionTarget,
      requireExplicitMessageTarget: false,
    };
  }

  return {
    actionTarget,
    originDelivery,
    fallbackDelivery: originDelivery,
    deliveryPromptMode: "summary",
    deliveryContract: "cron-owned",
    watchDeliveryConfigured,
    requireExplicitMessageTarget: false,
  };
}

export function resolveMonitorRecordWatchDelivery(
  monitor: MonitorRecord,
): CronDelivery | undefined {
  return resolveMonitorWatchDelivery({
    sourceType: monitor.sourceType,
    sourceTarget: monitor.sourceTarget,
    explicitWatchDelivery: monitor.watchDelivery,
  });
}
