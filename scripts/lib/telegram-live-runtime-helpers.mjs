import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT_BASE = 20000;
const DEFAULT_PORT_RANGE = 10000;

function normalizeTokenList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function stripOuterQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeStringList(values) {
  return normalizeTokenList(values);
}

function parseEnvAssignmentLine(line, key) {
  const match = String(line ?? "").match(
    new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*(.*)$`),
  );
  if (!match) {
    return null;
  }

  return stripOuterQuotes(match[1].trim());
}

export function deriveTelegramLiveRuntimeProfile(params) {
  const worktreePath = path.resolve(String(params?.worktreePath ?? ""));
  const stateRoot =
    params?.stateRoot && String(params.stateRoot).trim().length > 0
      ? path.resolve(String(params.stateRoot))
      : path.join(os.homedir(), ".openclaw", "telegram-live-worktrees");
  const portBase = Number.isFinite(params?.portBase) ? Number(params.portBase) : DEFAULT_PORT_BASE;
  const portRange =
    Number.isFinite(params?.portRange) && Number(params.portRange) > 0
      ? Number(params.portRange)
      : DEFAULT_PORT_RANGE;

  const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
  const profileId = `tg-live-${hash.slice(0, 10)}`;
  const hashInt = Number.parseInt(hash.slice(0, 8), 16);
  const runtimePort = portBase + (Number.isFinite(hashInt) ? hashInt % portRange : 0);
  const runtimeStateDir = path.join(stateRoot, profileId);

  return {
    worktreePath,
    profileId,
    runtimePort,
    runtimeStateDir,
  };
}

export function selectTelegramTesterToken(params) {
  const poolTokens = normalizeTokenList(params?.poolTokens ?? []);
  const claimedTokens = new Set(normalizeTokenList(params?.claimedTokens ?? []));
  const reservedTokens = new Set(normalizeTokenList(params?.reservedTokens ?? []));
  const currentToken = String(params?.currentToken ?? "").trim();

  if (poolTokens.length === 0) {
    return {
      ok: false,
      action: "fail",
      reason: "empty_pool",
      selectedToken: null,
    };
  }

  const isUnavailable = (token) => claimedTokens.has(token) || reservedTokens.has(token);

  if (currentToken && poolTokens.includes(currentToken) && !isUnavailable(currentToken)) {
    return {
      ok: true,
      action: "retain",
      reason: "current_available",
      selectedToken: currentToken,
    };
  }

  for (const candidate of poolTokens) {
    if (!isUnavailable(candidate)) {
      return {
        ok: true,
        action: "assign",
        reason: currentToken ? "reassign_conflict_or_invalid" : "first_claim",
        selectedToken: candidate,
      };
    }
  }

  return {
    ok: false,
    action: "fail",
    reason: "pool_exhausted",
    selectedToken: null,
  };
}

export function extractTelegramBotTokensFromConfig(config) {
  if (!config || typeof config !== "object") {
    return [];
  }

  const tokens = [];
  const telegram =
    config.channels && typeof config.channels === "object" && config.channels.telegram
      ? config.channels.telegram
      : null;

  if (telegram && typeof telegram === "object") {
    if (typeof telegram.botToken === "string" && telegram.botToken.trim()) {
      tokens.push(telegram.botToken.trim());
    }

    const accounts =
      telegram.accounts && typeof telegram.accounts === "object" ? telegram.accounts : {};
    for (const entry of Object.values(accounts)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (typeof entry.botToken === "string" && entry.botToken.trim()) {
        tokens.push(entry.botToken.trim());
      }
    }
  }

  return normalizeTokenList(tokens);
}

export function buildTelegramLiveRuntimeConfig(params) {
  const assignedToken = String(params?.assignedToken ?? "").trim();
  const runtimePort = Number.parseInt(String(params?.runtimePort ?? ""), 10);
  const workspaceDir =
    typeof params?.workspaceDir === "string" && params.workspaceDir.trim().length > 0
      ? path.resolve(params.workspaceDir.trim())
      : null;
  const dmPolicyOverride =
    typeof params?.dmPolicy === "string" && params.dmPolicy.trim().length > 0
      ? params.dmPolicy.trim()
      : null;
  const baseConfig =
    params?.baseConfig && typeof params.baseConfig === "object"
      ? structuredClone(params.baseConfig)
      : {};

  if (!assignedToken || !Number.isFinite(runtimePort) || runtimePort <= 0) {
    throw new Error("Missing assigned token or runtime port.");
  }

  const config = baseConfig;
  const gateway = config.gateway && typeof config.gateway === "object" ? config.gateway : {};
  const controlUi =
    gateway.controlUi && typeof gateway.controlUi === "object" ? gateway.controlUi : {};
  config.gateway = {
    ...gateway,
    port: runtimePort,
    bind: "loopback",
    mode: "local",
    controlUi: {
      ...controlUi,
      enabled: false,
      allowedOrigins: [`http://localhost:${runtimePort}`, `http://127.0.0.1:${runtimePort}`],
    },
  };

  const baseChannels =
    config.channels && typeof config.channels === "object" ? config.channels : {};
  const telegram =
    baseChannels.telegram && typeof baseChannels.telegram === "object" ? baseChannels.telegram : {};
  const basePlugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
  const pluginSlots =
    basePlugins.slots && typeof basePlugins.slots === "object" ? basePlugins.slots : {};
  const pluginEntries =
    basePlugins.entries && typeof basePlugins.entries === "object" ? basePlugins.entries : {};
  const baseTools =
    config.tools && typeof config.tools === "object" ? structuredClone(config.tools) : {};

  delete telegram.accounts;
  const nextTelegram = {
    ...telegram,
    enabled: true,
    botToken: assignedToken,
  };
  if (dmPolicyOverride) {
    nextTelegram.dmPolicy = dmPolicyOverride;
    if (dmPolicyOverride === "open") {
      const allowFrom = Array.isArray(nextTelegram.allowFrom)
        ? normalizeStringList(nextTelegram.allowFrom)
        : [];
      nextTelegram.allowFrom = allowFrom.includes("*") ? allowFrom : [...allowFrom, "*"];
    }
  }
  config.channels = {
    telegram: nextTelegram,
  };

  const agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  const agentDefaults =
    agents.defaults && typeof agents.defaults === "object" ? structuredClone(agents.defaults) : {};
  const defaultModel =
    agentDefaults.model && typeof agentDefaults.model === "object"
      ? structuredClone(agentDefaults.model)
      : {};
  if (workspaceDir) {
    agentDefaults.workspace = workspaceDir;
  }

  // Isolated Telegram tester lanes should not depend on the shared Codex OAuth
  // session. If an OpenAI API key already exists, prefer the equivalent GPT-5.4
  // API-key path so smoke tests stay isolated from refresh-token churn.
  if (
    config.env &&
    typeof config.env === "object" &&
    typeof config.env.OPENAI_API_KEY === "string" &&
    config.env.OPENAI_API_KEY.trim().length > 0
  ) {
    agentDefaults.model = {
      ...defaultModel,
      primary: "openai/gpt-5.4",
      fallbacks: Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : [],
    };
    config.agents = {
      ...agents,
      defaults: agentDefaults,
    };
  }
  if (workspaceDir || !Array.isArray(config.agents?.list) || config.agents.list.length !== 1) {
    config.agents = {
      ...config.agents,
      defaults: agentDefaults,
      // Keep Telegram live harnesses on a single main agent so inherited
      // home-workspace/topic bindings cannot leak into supposedly isolated runs.
      list: [{ id: "main" }],
    };
  }

  // The base founder config can carry topic bindings to other agents or ACP
  // runtimes. The isolated Telegram lane is supposed to prove one clean runtime
  // only, so inherited bindings are treated as contamination and removed.
  config.bindings = [];

  // Telegram live tester lanes must stay isolated from ACP/acpx because the
  // base config may otherwise auto-enable ACP before Telegram can reply.
  config.acp = {
    enabled: false,
    dispatch: {
      enabled: false,
    },
  };

  config.plugins = {
    ...basePlugins,
    enabled: true,
    allow: ["telegram"],
    // The isolated Telegram live harness runs bundled Telegram only. Inherited
    // deny entries from the founder config can reference plugins unavailable in
    // the current checkout, which makes doctor reject the runtime before it
    // even boots. Keep the denylist to the one thing we intentionally block.
    deny: ["acpx"],
    entries: {
      telegram: {
        ...(pluginEntries.telegram && typeof pluginEntries.telegram === "object"
          ? pluginEntries.telegram
          : {}),
        enabled: true,
      },
      acpx: {
        ...(pluginEntries.acpx && typeof pluginEntries.acpx === "object" ? pluginEntries.acpx : {}),
        enabled: false,
      },
    },
    slots: {
      ...pluginSlots,
      memory: "none",
    },
  };

  // Founder-config tool allowlists often include local experimental tool names
  // that do not exist in isolated Telegram lanes. Keep tool behavior, but drop
  // allowlist noise that would otherwise pollute live runtime logs.
  delete baseTools.alsoAllow;
  config.tools = baseTools;

  return config;
}

export function clearEnvAssignmentText(params) {
  const key = String(params?.key ?? "").trim();
  const content = String(params?.content ?? "");

  if (!key) {
    return {
      content,
      removed: false,
      removedValue: "",
    };
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/g);
  if (hadTrailingNewline && lines.at(-1) === "") {
    lines.pop();
  }
  const keptLines = [];
  let removedValue = "";

  // Drop every assignment for the key so releasing a worktree claim never
  // exposes an older value that was shadowed later in the file.
  for (const line of lines) {
    const parsed = parseEnvAssignmentLine(line, key);
    if (parsed === null) {
      keptLines.push(line);
      continue;
    }
    removedValue = parsed;
  }

  let nextContent = keptLines.join(newline);
  if (hadTrailingNewline && nextContent.length > 0) {
    nextContent += newline;
  }

  return {
    content: nextContent,
    removed: removedValue.length > 0,
    removedValue,
  };
}

function normalizeNumericId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesTelegramSessionTarget(entry, chatId, threadId, agentId) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const candidateAgentId =
    typeof entry.agentId === "string" && entry.agentId.trim()
      ? entry.agentId.trim()
      : typeof entry.origin?.agentId === "string" && entry.origin.agentId.trim()
        ? entry.origin.agentId.trim()
        : null;
  if (agentId && candidateAgentId && candidateAgentId !== agentId) {
    return false;
  }

  const channel = entry.channel ?? entry.deliveryContext?.channel ?? entry.origin?.provider;
  if (channel !== "telegram") {
    return false;
  }

  const candidateThreadIds = [
    entry.deliveryContext?.threadId,
    entry.lastThreadId,
    entry.origin?.threadId,
  ]
    .map(normalizeNumericId)
    .filter((value) => value !== null);
  if (!candidateThreadIds.includes(threadId)) {
    return false;
  }

  const candidateTargets = [
    entry.groupId,
    entry.lastTo,
    entry.origin?.from,
    entry.origin?.to,
    entry.deliveryContext?.to,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());

  if (chatId.startsWith("-")) {
    return candidateTargets.some((value) => value.includes(chatId));
  }

  return candidateTargets.some(
    (value) => value === `telegram:${chatId}` || value.endsWith(`:${chatId}`),
  );
}

export function pruneTelegramThreadSessions(params) {
  const sessions =
    params?.sessions && typeof params.sessions === "object" && !Array.isArray(params.sessions)
      ? { ...params.sessions }
      : {};
  const chatId = String(params?.chatId ?? "").trim();
  const threadId = normalizeNumericId(params?.threadId);
  const agentId = String(params?.agentId ?? "main").trim() || "main";

  if (!chatId || threadId === null) {
    return {
      sessions,
      removedKeys: [],
    };
  }

  const removedKeys = [];
  for (const [key, entry] of Object.entries(sessions)) {
    if (!key.startsWith(`agent:${agentId}:`)) {
      continue;
    }
    if (!matchesTelegramSessionTarget(entry, chatId, threadId, agentId)) {
      continue;
    }
    removedKeys.push(key);
    delete sessions[key];
  }

  return {
    sessions,
    removedKeys,
  };
}
