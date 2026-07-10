import type { CronSchedule } from "../cron/types.js";
import type { MonitorDisclosure } from "./types.js";

const MONITOR_RECEIPT_MARKER = "monitorReceipt";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeConsumerText(value: string): string {
  return value.replace(/\bcron jobs?\b/gi, "scheduled task").trim();
}

function formatCountedUnit(value: number, unit: string): string {
  return value === 1 ? unit : `${value} ${unit}s`;
}

function formatEveryDuration(ms: number): string {
  const durationMs = Math.max(1, Math.floor(ms));
  const units = [
    { size: 86_400_000, name: "day" },
    { size: 3_600_000, name: "hour" },
    { size: 60_000, name: "minute" },
    { size: 1_000, name: "second" },
  ];
  for (const unit of units) {
    if (durationMs >= unit.size && durationMs % unit.size === 0) {
      return `Every ${formatCountedUnit(durationMs / unit.size, unit.name)}`;
    }
  }
  return "Every less than a second";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(date);
  }
  return sanitizeConsumerText(value);
}

function formatClockTime(hour: number, minute: number, second?: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalizedHour = hour % 12 || 12;
  const minuteText = String(minute).padStart(2, "0");
  const secondText = second && second > 0 ? `:${String(second).padStart(2, "0")}` : "";
  return `${normalizedHour}:${minuteText}${secondText} ${suffix}`;
}

function formatCronCadence(schedule: Extract<CronSchedule, { kind: "cron" }>): string {
  const fields = schedule.expr.trim().split(/\s+/);
  const hasSeconds = fields.length === 6;
  const offset = hasSeconds ? 1 : 0;
  const second = hasSeconds ? fields[0] : undefined;
  const minute = fields[offset];
  const hour = fields[offset + 1];
  const dayOfMonth = fields[offset + 2];
  const month = fields[offset + 3];
  const dayOfWeek = fields[offset + 4];
  const timezone = schedule.tz ? ` (${schedule.tz})` : "";

  if (
    hasSeconds &&
    second === "*" &&
    minute === "*" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every second${timezone}`;
  }
  const secondStep = second?.match(/^\*\/(\d+)$/)?.[1];
  if (
    hasSeconds &&
    secondStep &&
    minute === "*" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every ${secondStep} seconds${timezone}`;
  }
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every minute${timezone}`;
  }
  const minuteStep = minute?.match(/^\*\/(\d+)$/)?.[1];
  if (minuteStep && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${minuteStep} minutes${timezone}`;
  }
  const hourStep = hour?.match(/^\*\/(\d+)$/)?.[1];
  if (minute === "0" && hourStep && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${hourStep} hours${timezone}`;
  }
  if (minute === "0" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every hour${timezone}`;
  }
  if (
    minute &&
    /^\d+$/.test(minute) &&
    hour &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*" &&
    (!hasSeconds || (second !== undefined && /^\d+$/.test(second)))
  ) {
    return `Daily at ${formatClockTime(
      Number(hour),
      Number(minute),
      second === undefined ? undefined : Number(second),
    )}${timezone}`;
  }
  return `On its configured schedule${timezone}`;
}

export function formatMonitorCadence(schedule: MonitorDisclosure["checkCadence"]): string {
  switch (schedule.kind) {
    case "every":
      return formatEveryDuration(schedule.everyMs);
    case "at":
      return `Once at ${formatDate(schedule.at)}`;
    case "cron":
      return formatCronCadence(schedule);
  }
}

function formatStopSummary(disclosure: MonitorDisclosure): string {
  const expiry = disclosure.expiryAt ? `until ${formatDate(disclosure.expiryAt)}` : undefined;
  const stop = disclosure.stopCondition
    ? `stop when ${sanitizeConsumerText(disclosure.stopCondition)}`
    : undefined;
  return [expiry, stop].filter(Boolean).join("; ") || "until you stop it";
}

function normalizeMonitorPurpose(purpose: string): string {
  const normalized = sanitizeConsumerText(purpose.replace(/\s+/g, " ")).replace(/[.!?]+$/, "");
  const withoutImperative = normalized.replace(
    /^(?:(?:watch|monitor|monitoring|check|track|follow)\s+(?:for\s+)?|look\s+for\s+)/i,
    "",
  );
  return withoutImperative.trim() || "this";
}

function formatNoChangeSummary(disclosure: MonitorDisclosure): string {
  const { noticeAfterChecks, reminderIntervalMs } = disclosure.noChangeCadence;
  const checkLabel = formatCountedUnit(noticeAfterChecks, "check");
  const reminderLabel = formatEveryDuration(reminderIntervalMs).replace(/^Every /, "every ");
  return `I'll message when something changes. If not, after ${checkLabel}, then ${reminderLabel}.`;
}

export function formatMonitorReceipt(disclosure: MonitorDisclosure): string {
  const purpose = normalizeMonitorPurpose(disclosure.purpose);
  const shortPurpose = purpose.length > 120 ? `${purpose.slice(0, 117).trimEnd()}...` : purpose;
  return [
    `Monitoring ${shortPurpose}`,
    `${formatMonitorCadence(disclosure.checkCadence)} · ${formatStopSummary(disclosure)}`,
    formatNoChangeSummary(disclosure),
  ].join("\n");
}

export function buildMonitorReceiptChannelData(
  disclosure: MonitorDisclosure,
): Record<string, unknown> {
  return {
    openclaw: {
      [MONITOR_RECEIPT_MARKER]: { disclosure },
    },
  };
}

export function readMonitorReceiptDisclosure(channelData: unknown): MonitorDisclosure | undefined {
  const channel = asRecord(channelData);
  const openclaw = asRecord(channel?.openclaw);
  const marker = asRecord(openclaw?.[MONITOR_RECEIPT_MARKER]);
  const disclosure = asRecord(marker?.disclosure);
  return disclosure ? (disclosure as unknown as MonitorDisclosure) : undefined;
}
