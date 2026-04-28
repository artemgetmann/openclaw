import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizeAgentIds(values) {
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

function scrubInheritedOpenAiSecrets(node) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      scrubInheritedOpenAiSecrets(entry);
    }
    return node;
  }

  const obj = node;
  const envVars = obj.env && typeof obj.env === "object" ? obj.env : null;
  if (envVars) {
    const vars = envVars.vars && typeof envVars.vars === "object" ? envVars.vars : null;
    if (vars) {
      for (const key of Object.keys(vars)) {
        if (/^OPENAI(?:_.+)?_API_KEY$/.test(key) || key === "OPENCLAW_CONSUMER_OPENAI_API_KEY") {
          delete vars[key];
        }
      }
    }
    for (const key of Object.keys(envVars)) {
      if (/^OPENAI(?:_.+)?_API_KEY$/.test(key) || key === "OPENCLAW_CONSUMER_OPENAI_API_KEY") {
        delete envVars[key];
      }
    }
  }

  const provider = typeof obj.provider === "string" ? obj.provider.trim().toLowerCase() : "";
  if (provider === "openai" && "apiKey" in obj) {
    delete obj.apiKey;
  }

  const modelProviders = obj.models && typeof obj.models === "object" ? obj.models.providers : null;
  if (modelProviders && typeof modelProviders === "object") {
    const openaiProvider = modelProviders.openai;
    if (openaiProvider && typeof openaiProvider === "object") {
      delete openaiProvider.apiKey;
    }
  }

  const ttsOpenAi = obj.messages?.tts?.openai;
  if (ttsOpenAi && typeof ttsOpenAi === "object") {
    delete ttsOpenAi.apiKey;
  }

  if (
    typeof obj.apiKey === "string" &&
    (/\$\{OPENAI(?:_.+)?_API_KEY\}/.test(obj.apiKey) ||
      /\$\{OPENCLAW_CONSUMER_OPENAI_API_KEY\}/.test(obj.apiKey))
  ) {
    delete obj.apiKey;
  }

  for (const value of Object.values(obj)) {
    scrubInheritedOpenAiSecrets(value);
  }

  return obj;
}

export function deriveWorktreeTesterBaseline(params) {
  const worktreePath = path.resolve(String(params?.worktreePath ?? ""));
  const stateRoot =
    params?.stateRoot && String(params.stateRoot).trim().length > 0
      ? path.resolve(String(params.stateRoot).trim())
      : path.join(os.homedir(), ".openclaw", "worktree-runtimes");
  // The baseline id must be deterministic for a given worktree path so every
  // bootstrap entry point converges on the same durable runtime snapshot.
  const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
  const baselineId = `wt-${hash.slice(0, 10)}`;
  const stateDir = path.join(stateRoot, baselineId);
  return {
    worktreePath,
    baselineId,
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    metaPath: path.join(stateDir, "auth-sync.json"),
  };
}

export function sanitizeInheritedTesterConfig(baseConfig) {
  return sanitizeInheritedTesterConfigWithMetadata(baseConfig).config;
}

export function sanitizeInheritedTesterConfigWithMetadata(baseConfig) {
  const config = baseConfig && typeof baseConfig === "object" ? structuredClone(baseConfig) : {};
  const channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  const telegram =
    channels.telegram && typeof channels.telegram === "object" ? { ...channels.telegram } : null;
  const strippedTelegramCredentials = [];

  if (telegram) {
    // Tester lanes inherit provider/model config, not ownership of the shared
    // Telegram bot credentials from the sacred runtime.
    if (typeof telegram.botToken === "string" && telegram.botToken.trim()) {
      strippedTelegramCredentials.push({
        accountId: "default",
        accountKind: "default",
        sourceKind: "botToken",
      });
      delete telegram.botToken;
    }
    if (typeof telegram.tokenFile === "string" && telegram.tokenFile.trim()) {
      strippedTelegramCredentials.push({
        accountId: "default",
        accountKind: "default",
        sourceKind: "tokenFile",
      });
      delete telegram.tokenFile;
    }
    const accounts =
      telegram.accounts && typeof telegram.accounts === "object" ? { ...telegram.accounts } : null;
    if (accounts) {
      for (const [accountId, entry] of Object.entries(accounts)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const next = { ...entry };
        if (typeof next.botToken === "string" && next.botToken.trim()) {
          strippedTelegramCredentials.push({
            accountId,
            accountKind: accountId === "default" ? "default" : "named",
            sourceKind: "botToken",
          });
          delete next.botToken;
        }
        if (typeof next.tokenFile === "string" && next.tokenFile.trim()) {
          strippedTelegramCredentials.push({
            accountId,
            accountKind: accountId === "default" ? "default" : "named",
            sourceKind: "tokenFile",
          });
          delete next.tokenFile;
        }
        accounts[accountId] = next;
      }
      telegram.accounts = accounts;
    }
    config.channels = {
      ...channels,
      telegram,
    };
  }

  scrubInheritedOpenAiSecrets(config);
  return {
    config,
    metadata: {
      strippedTelegramCredentials,
      strippedNamedTelegramAccounts: [
        ...new Set(
          strippedTelegramCredentials
            .filter((entry) => entry.accountKind === "named")
            .map((entry) => entry.accountId),
        ),
      ],
    },
  };
}

export function resolveTesterBaselineAgentIds(baseConfig) {
  const configuredAgents = Array.isArray(baseConfig?.agents?.list) ? baseConfig.agents.list : [];
  // Always include the primary agent path even if the source config omits it.
  const agentIds = ["main"];
  for (const entry of configuredAgents) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    agentIds.push(entry.id);
  }
  return normalizeAgentIds(agentIds);
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
