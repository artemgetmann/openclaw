import {
  normalizeAccountId,
  resolveConfiguredFromCredentialStatuses,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/telegram";
import {
  inspectTelegramAccount,
  type InspectedTelegramAccount,
} from "./account-inspect.js";
import { listTelegramAccountIds } from "./accounts.js";

type TelegramSetupInspectionAccount = Pick<InspectedTelegramAccount, "accountId" | "token"> &
  Partial<Pick<InspectedTelegramAccount, "tokenStatus" | "configured">>;

export type TelegramSetupVerification = {
  hasToken: boolean;
  configured: boolean;
  duplicateTokenOwnerAccountId: string | null;
  duplicateTokenReason: string | null;
};

export type TelegramAccountSetupStatusKind =
  | "not_configured"
  | "configured"
  | "ready"
  | "blocked";

export type TelegramAccountSetupStatusMetadata = {
  status: TelegramAccountSetupStatusKind;
  credentialConfigured: boolean;
  ready: boolean;
  blocked: boolean;
  blockedReason: string | null;
  verification: TelegramSetupVerification;
};

// Keep setup verification in one place so the setup wizard, setup-only plugin,
// and runtime plugin all agree on when Telegram is actually usable.
function resolveSetupInspection(params: {
  cfg: OpenClawConfig;
  account?: TelegramSetupInspectionAccount;
  accountId?: string;
}): TelegramSetupInspectionAccount {
  if (params.account) {
    return params.account;
  }
  return inspectTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
}

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ cfg: params.cfg, accountId: id });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

export function verifyTelegramSetupAccount(params: {
  cfg: OpenClawConfig;
  account?: TelegramSetupInspectionAccount;
  accountId?: string;
}): TelegramSetupVerification {
  const account = resolveSetupInspection(params);
  const hasToken = Boolean(account.token?.trim());
  if (!hasToken) {
    return {
      hasToken: false,
      configured: false,
      duplicateTokenOwnerAccountId: null,
      duplicateTokenReason: null,
    };
  }
  const duplicateTokenOwnerAccountId = findTelegramTokenOwnerAccountId({
    cfg: params.cfg,
    accountId: account.accountId,
  });
  return {
    hasToken: true,
    configured: !duplicateTokenOwnerAccountId,
    duplicateTokenOwnerAccountId,
    duplicateTokenReason: duplicateTokenOwnerAccountId
      ? formatDuplicateTelegramTokenReason({
          accountId: account.accountId,
          ownerAccountId: duplicateTokenOwnerAccountId,
        })
      : null,
  };
}

export function resolveTelegramAccountSetupStatus(params: {
  cfg: OpenClawConfig;
  account?: TelegramSetupInspectionAccount;
  accountId?: string;
}): TelegramAccountSetupStatusMetadata {
  const account = resolveSetupInspection(params);
  const verification = verifyTelegramSetupAccount({
    cfg: params.cfg,
    account,
  });
  // Keep semantics here so every caller agrees on the difference between:
  // - "configured": credentials exist somewhere
  // - "ready": Telegram can actually start right now
  // - "blocked": credentials exist, but setup semantics forbid startup
  const credentialConfigured =
    resolveConfiguredFromCredentialStatuses(account) ?? verification.hasToken;
  const blockedReason = verification.duplicateTokenReason;
  const blocked = credentialConfigured && Boolean(blockedReason);
  const ready = credentialConfigured && verification.configured;
  const status: TelegramAccountSetupStatusKind = blocked
    ? "blocked"
    : ready
      ? "ready"
      : credentialConfigured
        ? "configured"
        : "not_configured";
  return {
    status,
    credentialConfigured,
    ready,
    blocked,
    blockedReason: blockedReason ?? null,
    verification,
  };
}

export function resolveTelegramSetupConfigured(cfg: OpenClawConfig): boolean {
  return listTelegramAccountIds(cfg).some((accountId) =>
    resolveTelegramAccountSetupStatus({ cfg, accountId }).ready,
  );
}

export function resolveTelegramAccountSetupUnconfiguredReason(params: {
  cfg: OpenClawConfig;
  account?: TelegramSetupInspectionAccount;
  accountId?: string;
}): string {
  const status = resolveTelegramAccountSetupStatus(params);
  if (status.blockedReason) {
    return status.blockedReason;
  }
  return "not configured";
}
