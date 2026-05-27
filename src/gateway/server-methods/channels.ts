import {
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../../extensions/telegram/src/accounts.js";
import { createTelegramBot } from "../../../extensions/telegram/src/bot.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { withTimeout } from "../../utils/with-timeout.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

type TelegramSetupReplayPayload = {
  updateId: number;
  messageId: number;
  chatId: number;
  senderId: number;
  date: number;
  text?: string;
  caption?: string;
  chatUsername?: string;
  senderUsername?: string;
  senderFirstName?: string;
  messageThreadId?: number;
};

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  throw new Error(`${label} must be a finite number`);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseTelegramSetupReplayParams(params: Record<string, unknown>): {
  payload: TelegramSetupReplayPayload;
  timeoutMs: number;
} {
  const rawPayload = params.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new Error("payload must be an object");
  }
  const payloadRecord = rawPayload as Record<string, unknown>;
  const text = readOptionalString(payloadRecord.text);
  const caption = readOptionalString(payloadRecord.caption);
  if (!text && !caption) {
    throw new Error("payload.text or payload.caption is required");
  }
  const timeoutMsRaw = params.timeoutMs;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
      ? Math.max(1000, Math.trunc(timeoutMsRaw))
      : 8000;

  const chatUsername = readOptionalString(payloadRecord.chatUsername);
  const senderUsername = readOptionalString(payloadRecord.senderUsername);
  const senderFirstName = readOptionalString(payloadRecord.senderFirstName);

  return {
    timeoutMs,
    payload: {
      updateId: readFiniteNumber(payloadRecord.updateId, "payload.updateId"),
      messageId: readFiniteNumber(payloadRecord.messageId, "payload.messageId"),
      chatId: readFiniteNumber(payloadRecord.chatId, "payload.chatId"),
      senderId: readFiniteNumber(payloadRecord.senderId, "payload.senderId"),
      date: readFiniteNumber(payloadRecord.date, "payload.date"),
      ...(text ? { text } : {}),
      ...(caption ? { caption } : {}),
      ...(chatUsername ? { chatUsername } : {}),
      ...(senderUsername ? { senderUsername } : {}),
      ...(senderFirstName ? { senderFirstName } : {}),
      ...(typeof payloadRecord.messageThreadId === "number" &&
      Number.isFinite(payloadRecord.messageThreadId)
        ? { messageThreadId: Math.trunc(payloadRecord.messageThreadId) }
        : {}),
    },
  };
}

function buildTelegramSetupReplayUpdate(payload: TelegramSetupReplayPayload) {
  const username = payload.senderUsername?.replace(/^@/, "");
  return {
    update_id: payload.updateId,
    message: {
      message_id: payload.messageId,
      date: payload.date,
      chat: {
        id: payload.chatId,
        type: "private",
        ...(payload.chatUsername ? { username: payload.chatUsername.replace(/^@/, "") } : {}),
        ...(payload.senderFirstName ? { first_name: payload.senderFirstName } : {}),
      },
      from: {
        id: payload.senderId,
        is_bot: false,
        first_name: payload.senderFirstName ?? username ?? "Telegram user",
        ...(username ? { username } : {}),
      },
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.caption ? { caption: payload.caption } : {}),
      ...(payload.messageThreadId != null ? { message_thread_id: payload.messageThreadId } : {}),
    },
  };
}

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.telegram.setup-replay": async ({ params, respond }) => {
    // Consumer setup captures the first DM while polling is paused. Replay that
    // update through the normal Telegram bot middleware so verification proves
    // the real reply path rather than only checking token/config state.
    let replayParams: ReturnType<typeof parseTelegramSetupReplayParams>;
    try {
      replayParams = parseTelegramSetupReplayParams(params);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.telegram.setup-replay params: ${formatForLog(err)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const accountId = resolveDefaultTelegramAccountId(cfg);
    const account = resolveTelegramAccount({ cfg, accountId });
    const token = account.token.trim();
    if (!token) {
      respond(true, {
        ok: false,
        replyStarted: false,
        replyCompleted: false,
        error: "Telegram bot token is not configured.",
      });
      return;
    }

    const before = getChannelActivity({ channel: "telegram", accountId: account.accountId });
    const update = buildTelegramSetupReplayUpdate(replayParams.payload);
    try {
      const bot = createTelegramBot({
        token,
        accountId: account.accountId,
        config: cfg,
        runtime: defaultRuntime,
      });
      await withTimeout(
        bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]),
        replayParams.timeoutMs,
      );
      const after = getChannelActivity({ channel: "telegram", accountId: account.accountId });
      // The Telegram delivery layer records outbound activity after a reply is
      // actually sent. Return that as the app-visible setup completion signal.
      const replyCompleted =
        after.outboundAt != null &&
        (before.outboundAt == null || after.outboundAt > before.outboundAt);
      respond(true, {
        ok: replyCompleted,
        replyStarted: true,
        replyCompleted,
        ...(replyCompleted
          ? {}
          : {
              error:
                "Jarvis processed the first Telegram message, but no reply activity was confirmed.",
            }),
      });
    } catch (err) {
      respond(true, {
        ok: false,
        replyStarted: true,
        replyCompleted: false,
        error: formatForLog(err),
      });
    }
  },

  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : probe ? 20_000 : 10_000;
    const requestStartedAt = Date.now();
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const formatStepFailure = (err: unknown, stepLabel: string) => {
      const detail =
        err instanceof Error && err.message === "timeout"
          ? `${stepLabel} timed out after ${timeoutMs}ms`
          : formatForLog(err);
      return detail;
    };

    const runProbeStep = async <T>(params: {
      stepLabel: string;
      run: () => Promise<T>;
    }): Promise<{ value?: T; error?: string; elapsedMs: number }> => {
      const stepStartedAt = Date.now();
      try {
        const value = await withTimeout(params.run(), timeoutMs);
        return {
          value,
          elapsedMs: Date.now() - stepStartedAt,
        };
      } catch (err) {
        const error = formatStepFailure(err, params.stepLabel);
        context.logGateway.warn(
          `[channels.status] ${params.stepLabel} failed after ${Date.now() - stepStartedAt}ms: ${error}`,
        );
        return {
          error,
          elapsedMs: Date.now() - stepStartedAt,
        };
      }
    };

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const resolvedAccounts: Record<string, unknown> = {};
      const accounts = await Promise.all(
        accountIds.map(async (accountId) => {
          const account = plugin.config.resolveAccount(cfg, accountId);
          const enabled = isAccountEnabled(plugin, account);
          resolvedAccounts[accountId] = account;
          let configured = true;
          let configuredError: string | undefined;
          if (plugin.config.isConfigured) {
            try {
              configured = await plugin.config.isConfigured(account, cfg);
            } catch (err) {
              configured = false;
              configuredError = `config check failed: ${formatForLog(err)}`;
              context.logGateway.warn(
                `[channels.status] ${channelId}:${accountId} config check failed: ${configuredError}`,
              );
            }
          }
          let probeResult: unknown;
          let lastProbeAt: number | null = null;
          if (probe && enabled && plugin.status?.probeAccount) {
            if (configured) {
              const probeStep = await runProbeStep({
                stepLabel: `${channelId}:${accountId} probe`,
                run: async () =>
                  await plugin.status!.probeAccount!({
                    account,
                    timeoutMs,
                    cfg,
                  }),
              });
              probeResult =
                probeStep.error !== undefined
                  ? {
                      ok: false,
                      error: probeStep.error,
                      elapsedMs: probeStep.elapsedMs,
                    }
                  : probeStep.value;
              lastProbeAt = Date.now();
            }
          }
          let auditResult: unknown;
          if (probe && enabled && plugin.status?.auditAccount) {
            if (configured) {
              const auditStep = await runProbeStep({
                stepLabel: `${channelId}:${accountId} audit`,
                run: async () =>
                  await plugin.status!.auditAccount!({
                    account,
                    timeoutMs,
                    cfg,
                    probe: probeResult,
                  }),
              });
              auditResult =
                auditStep.error !== undefined
                  ? {
                      ok: false,
                      error: auditStep.error,
                      elapsedMs: auditStep.elapsedMs,
                    }
                  : auditStep.value;
            }
          }
          const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
          try {
            const snapshot = await buildChannelAccountSnapshot({
              plugin,
              cfg,
              accountId,
              runtime: runtimeSnapshot,
              probe: probeResult,
              audit: auditResult,
            });
            // Preserve probe/audit visibility even when a plugin snapshot only
            // reports stable account metadata. Without this, probe mode can do
            // real work and then silently drop the result from the RPC payload.
            if (probeResult !== undefined && snapshot.probe === undefined) {
              snapshot.probe = probeResult;
            }
            if (auditResult !== undefined && snapshot.audit === undefined) {
              snapshot.audit = auditResult;
            }
            if (lastProbeAt) {
              snapshot.lastProbeAt = lastProbeAt;
            }
            if (configuredError && !snapshot.lastError) {
              snapshot.lastError = configuredError;
            }
            const activity = getChannelActivity({
              channel: channelId as never,
              accountId,
            });
            if (snapshot.lastInboundAt == null) {
              snapshot.lastInboundAt = activity.inboundAt;
            }
            if (snapshot.lastOutboundAt == null) {
              snapshot.lastOutboundAt = activity.outboundAt;
            }
            return snapshot;
          } catch (err) {
            const lastError = `status snapshot failed: ${formatForLog(err)}`;
            context.logGateway.warn(
              `[channels.status] ${channelId}:${accountId} snapshot failed: ${lastError}`,
            );
            return {
              accountId,
              enabled,
              configured,
              lastError: configuredError ?? lastError,
              probe: probeResult,
              audit: auditResult,
              ...(lastProbeAt ? { lastProbeAt } : {}),
            } satisfies ChannelAccountSnapshot;
          }
        }),
      );
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(plugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    for (const plugin of plugins) {
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildChannelAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
      let summary: Record<string, unknown>;
      try {
        summary = plugin.status?.buildChannelSummary
          ? await plugin.status.buildChannelSummary({
              account: fallbackAccount,
              cfg,
              defaultAccountId,
              snapshot:
                defaultAccount ??
                ({
                  accountId: defaultAccountId,
                } as ChannelAccountSnapshot),
            })
          : {
              configured: defaultAccount?.configured ?? false,
            };
      } catch (err) {
        const lastError = `channel summary failed: ${formatForLog(err)}`;
        context.logGateway.warn(`[channels.status] ${plugin.id} summary failed: ${lastError}`);
        summary = {
          configured: defaultAccount?.configured ?? false,
          lastError,
        };
      }
      channelsMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    if (probe) {
      context.logGateway.info(
        `[channels.status] probe completed in ${Date.now() - requestStartedAt}ms across ${plugins.length} channel(s)`,
      );
    }
    respond(true, payload, undefined);
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
