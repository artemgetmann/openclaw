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
  const config = baseConfig && typeof baseConfig === "object" ? structuredClone(baseConfig) : {};
  const channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  const telegram =
    channels.telegram && typeof channels.telegram === "object" ? { ...channels.telegram } : null;

  if (telegram) {
    // Tester lanes inherit provider/model config, not ownership of the shared
    // Telegram bot credentials from the sacred runtime.
    delete telegram.botToken;
    const accounts =
      telegram.accounts && typeof telegram.accounts === "object" ? { ...telegram.accounts } : null;
    if (accounts) {
      for (const [accountId, entry] of Object.entries(accounts)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const next = { ...entry };
        delete next.botToken;
        accounts[accountId] = next;
      }
      telegram.accounts = accounts;
    }
    config.channels = {
      ...channels,
      telegram,
    };
  }

  return config;
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
