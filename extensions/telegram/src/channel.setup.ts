import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  TelegramConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/telegram";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import type { TelegramProbe } from "./probe.js";
import { telegramSetupAdapter } from "./setup-core.js";
import {
  resolveTelegramAccountSetupStatus,
  resolveTelegramAccountSetupUnconfiguredReason,
} from "./setup-state.js";
import { telegramSetupWizard } from "./setup-surface.js";

const telegramConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account: ResolvedTelegramAccount) => account.config.defaultTo,
});

const telegramConfigBase = createScopedChannelConfigBase<ResolvedTelegramAccount>({
  sectionKey: "telegram",
  listAccountIds: listTelegramAccountIds,
  resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
});

export const telegramSetupPlugin: ChannelPlugin<ResolvedTelegramAccount, TelegramProbe> = {
  id: "telegram",
  meta: {
    ...getChatChannelMeta("telegram"),
    quickstartAllowFrom: true,
  },
  setupWizard: telegramSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    polls: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.telegram"] },
  configSchema: buildChannelConfigSchema(TelegramConfigSchema),
  config: {
    ...telegramConfigBase,
    isConfigured: (account, cfg) => resolveTelegramAccountSetupStatus({ cfg, account }).ready,
    unconfiguredReason: (account, cfg) =>
      resolveTelegramAccountSetupUnconfiguredReason({ cfg, account }),
    describeAccount: (account, cfg) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: resolveTelegramAccountSetupStatus({ cfg, account }).ready,
      tokenSource: account.tokenSource,
    }),
    ...telegramConfigAccessors,
  },
  setup: telegramSetupAdapter,
};
