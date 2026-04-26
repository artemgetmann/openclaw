import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT_BASE = 20000;
const DEFAULT_PORT_RANGE = 10000;
const DEFAULT_CODEX_TESTER_MODEL = "openai-codex/gpt-5.4";

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

function normalizeProviderId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^z-ai$/u, "zai");
}

function resolveModelProvider(modelRef) {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return "";
  }
  return normalizeProviderId(trimmed.slice(0, slashIndex));
}

function isTruthyEnvFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isTelegramLiveAcpValidationEnabled(params) {
  return isTruthyEnvFlag(params?.acpValidation);
}

function resolveTelegramLivePreferredModel(params) {
  const preferredModel = String(params?.preferredModel ?? "").trim();
  if (preferredModel) {
    return preferredModel;
  }

  // ACP validation and local Codex-auth tester lanes must stay on Codex unless
  // the caller explicitly overrides them. Otherwise inherited Anthropic/OpenAI
  // defaults can trigger missing-secret prechecks before the usable Codex auth
  // profile is even considered.
  if (isTelegramLiveAcpValidationEnabled(params) || params?.preferCodexAuth === true) {
    return DEFAULT_CODEX_TESTER_MODEL;
  }

  return "";
}

function isCodexPinnedModel(model) {
  return String(model ?? "")
    .trim()
    .toLowerCase()
    .startsWith("openai-codex/");
}

function isPlainOpenAiModel(model) {
  return resolveModelProvider(model) === "openai";
}

function codexTwinForPlainOpenAiModel(model) {
  const trimmed = String(model ?? "").trim();
  if (!isPlainOpenAiModel(trimmed)) {
    return "";
  }
  return `openai-codex/${trimmed.slice("openai/".length)}`;
}

function normalizeModelFallbacks(fallbacks) {
  return normalizeTokenList(Array.isArray(fallbacks) ? fallbacks : []);
}

function resolveConfiguredModelPrimary(modelConfig) {
  if (typeof modelConfig === "string") {
    return modelConfig.trim();
  }
  if (modelConfig && typeof modelConfig === "object") {
    return String(modelConfig.primary ?? "").trim();
  }
  return "";
}

function sanitizeTelegramTesterModelSelection(params) {
  const preferredModel = String(params?.preferredModel ?? "").trim();
  const currentModelConfig =
    typeof params?.currentModelConfig === "string" ||
    (params?.currentModelConfig && typeof params.currentModelConfig === "object")
      ? params.currentModelConfig
      : {};

  const inheritedPrimary = resolveConfiguredModelPrimary(currentModelConfig);
  const inheritedFallbacks = normalizeModelFallbacks(currentModelConfig.fallbacks);
  const safeFallbacks = inheritedFallbacks.filter(
    (model) => model !== preferredModel && model !== inheritedPrimary && !isPlainOpenAiModel(model),
  );

  // Tester/live lanes must never silently keep the product's plain OpenAI
  // default. If the caller did not force a model, try inherited safe fallbacks
  // first, then fall back to the Codex twin of the inherited OpenAI default.
  if (preferredModel) {
    return {
      effectiveModel: preferredModel,
      fallbackModels: [],
    };
  }

  if (inheritedPrimary && !isPlainOpenAiModel(inheritedPrimary)) {
    return {
      effectiveModel: inheritedPrimary,
      fallbackModels: safeFallbacks,
    };
  }

  const safeInheritedFallback = safeFallbacks[0] ?? "";
  if (safeInheritedFallback) {
    return {
      effectiveModel: safeInheritedFallback,
      fallbackModels: safeFallbacks.filter((model) => model !== safeInheritedFallback),
    };
  }

  const codexTwin = codexTwinForPlainOpenAiModel(inheritedPrimary);
  return {
    effectiveModel: codexTwin,
    fallbackModels: [],
  };
}

function stripRawOpenAiEnvKeys(env) {
  if (!env || typeof env !== "object") {
    return env;
  }

  const rawOpenAiEnvKeys = [
    "OPENAI_API_KEY",
    "OPENAI_MODEL_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_MODEL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "OPENAI_PROJECT_ID",
    "OPENCLAW_CONSUMER_OPENAI_API_KEY",
  ];

  for (const key of rawOpenAiEnvKeys) {
    delete env[key];
  }

  return env;
}

function codexTwinModelKey(model) {
  const trimmed = String(model ?? "").trim();
  if (!isCodexPinnedModel(trimmed)) {
    return null;
  }
  return `openai/${trimmed.slice("openai-codex/".length)}`;
}

function sanitizeTelegramLiveAcpValidationAuth(config) {
  const auth = config.auth && typeof config.auth === "object" ? config.auth : null;
  if (!auth) {
    return;
  }

  const profiles = auth.profiles && typeof auth.profiles === "object" ? auth.profiles : {};
  const codexProfiles = Object.fromEntries(
    Object.entries(profiles).filter(([, profile]) => {
      return (
        profile &&
        typeof profile === "object" &&
        String(profile.provider ?? "")
          .trim()
          .toLowerCase() === "openai-codex"
      );
    }),
  );

  const order = auth.order && typeof auth.order === "object" ? auth.order : {};
  const nextOrder =
    Object.prototype.hasOwnProperty.call(order, "openai-codex") &&
    order["openai-codex"] &&
    typeof order["openai-codex"] === "object"
      ? { "openai-codex": structuredClone(order["openai-codex"]) }
      : {};

  config.auth = {
    ...auth,
    profiles: codexProfiles,
    order: nextOrder,
  };
}

function scrubOpenAiSecretsFromTesterRuntimeConfig(node) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      scrubOpenAiSecretsFromTesterRuntimeConfig(entry);
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
    scrubOpenAiSecretsFromTesterRuntimeConfig(value);
  }

  return obj;
}

function normalizeClaimEntries(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const token = String(value.token ?? "").trim();
    const worktreePath = String(value.worktreePath ?? "").trim();
    if (!token || !worktreePath) {
      continue;
    }

    const key = `${token}\u0000${worktreePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ token, worktreePath });
  }

  return out;
}

function normalizePathForComparison(targetPath) {
  const trimmed = String(targetPath ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return fs.realpathSync.native(path.resolve(trimmed));
  } catch {
    return path.resolve(trimmed);
  }
}

function parseLaunchctlPid(output) {
  const match =
    String(output ?? "").match(/^\s*pid\s*=\s*(\d+)\s*$/m) ??
    String(output ?? "").match(/^\s*"pid"\s*=\s*(\d+)\s*$/m);
  const pid = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function resolveCanonicalMainRepoRoot(params) {
  const env = params?.env && typeof params.env === "object" ? params.env : process.env;
  const home = String(env.HOME ?? process.env.HOME ?? os.homedir()).trim();
  const candidates = [
    env.OPENCLAW_MAIN_REPO,
    home ? path.join(home, "Programming_Projects", "openclaw") : "",
    home ? path.join(home, "Projects", "openclaw") : "",
  ]
    .map((candidate) => normalizePathForComparison(candidate))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, ".git")) ||
      fs.existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
  }

  return candidates[0] ?? null;
}

export function isCanonicalSharedGatewayActive(params) {
  const env = params?.env && typeof params.env === "object" ? params.env : process.env;
  const execTextFn = typeof params?.execTextFn === "function" ? params.execTextFn : execText;
  const getUidFn = typeof params?.getUidFn === "function" ? params.getUidFn : process.getuid;
  const canonicalMainRepoRoot =
    normalizePathForComparison(params?.canonicalMainRepoPath) ??
    resolveCanonicalMainRepoRoot({ env });
  if (!canonicalMainRepoRoot || typeof getUidFn !== "function") {
    return false;
  }

  // Match the active launchd-owned main runtime only; config presence alone is not ownership.
  const label = String(env.OPENCLAW_CANONICAL_SHARED_GATEWAY_LABEL ?? "ai.openclaw.gateway").trim();
  const launchState = execTextFn("launchctl", ["print", `gui/${getUidFn()}/${label}`]);
  const pid = parseLaunchctlPid(launchState);
  if (!launchState || pid === null) {
    return false;
  }

  const expectedRuntime = path.join(canonicalMainRepoRoot, "dist", "index.js");
  const expectedEntrypoint = path.join(canonicalMainRepoRoot, "openclaw.mjs");
  if (!launchState.includes(expectedRuntime) && !launchState.includes(expectedEntrypoint)) {
    return false;
  }

  const command = execTextFn("ps", ["-o", "command=", "-p", String(pid)]);
  return Boolean(
    command &&
    (command.includes(expectedRuntime) ||
      command.includes(expectedEntrypoint) ||
      command.includes(" gateway run") ||
      command.includes("openclaw-gateway")),
  );
}

export function collectActiveReservedTelegramBotTokensFromCanonicalConfig(params) {
  const env = params?.env && typeof params.env === "object" ? params.env : process.env;
  if (
    !isCanonicalSharedGatewayActive({
      env,
      execTextFn: params?.execTextFn,
      getUidFn: params?.getUidFn,
      canonicalMainRepoPath: params?.canonicalMainRepoPath,
    })
  ) {
    return [];
  }

  const baseConfigPath = String(params?.baseConfigPath ?? "").trim();
  if (!baseConfigPath || !fs.existsSync(baseConfigPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
    return extractTelegramBotTokensFromConfig(parsed);
  } catch {
    return [];
  }
}

function normalizeLeaseEntries(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const token = String(value.token ?? "").trim();
    const worktreePath = String(value.worktreePath ?? "").trim();
    const pid = Number.parseInt(String(value.pid ?? ""), 10);
    if (!token || !worktreePath || !Number.isFinite(pid) || pid <= 0) {
      continue;
    }

    const key = `${token}\u0000${worktreePath}\u0000${pid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      token,
      worktreePath,
      pid,
      accountId: String(value.accountId ?? "").trim() || null,
    });
  }

  return out;
}

function hashTelegramToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function resolveCodexHomePath(codexHome) {
  const configured = String(codexHome ?? process.env.CODEX_HOME ?? "").trim();
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  }
  return path.join(os.homedir(), ".codex");
}

export function isLocalCodexAuthAvailable(params = {}) {
  const codexHome = resolveCodexHomePath(params.codexHome);
  const codexAuthPath = path.join(codexHome, "auth.json");
  if (!fs.existsSync(codexAuthPath)) {
    return false;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
    const tokens = raw && typeof raw === "object" ? raw.tokens : null;
    return Boolean(
      typeof tokens?.access_token === "string" &&
      tokens.access_token.trim() &&
      typeof tokens?.refresh_token === "string" &&
      tokens.refresh_token.trim(),
    );
  } catch {
    return false;
  }
}

function decodeJwtExpiryMs(token) {
  if (typeof token !== "string" || !token) {
    return null;
  }

  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) {
      return null;
    }
    return exp * 1000;
  } catch {
    return null;
  }
}

export function bootstrapTelegramLiveCodexAuthStore(params) {
  const runtimeStateDir = path.resolve(String(params?.runtimeStateDir ?? ""));
  const agentId = String(params?.agentId ?? "main").trim() || "main";
  if (!runtimeStateDir) {
    throw new Error("Missing runtimeStateDir for Telegram Codex auth bootstrap.");
  }

  const codexHome = resolveCodexHomePath(params?.codexHome);
  const codexAuthPath = path.join(codexHome, "auth.json");
  if (!fs.existsSync(codexAuthPath)) {
    return {
      ok: false,
      reason: "codex_auth_missing",
      codexAuthPath,
      authStorePath: path.join(runtimeStateDir, "agents", agentId, "agent", "auth-profiles.json"),
    };
  }

  const raw = JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
  const tokens = raw && typeof raw === "object" ? raw.tokens : null;
  const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!access || !refresh) {
    return {
      ok: false,
      reason: "codex_auth_invalid",
      codexAuthPath,
      authStorePath: path.join(runtimeStateDir, "agents", agentId, "agent", "auth-profiles.json"),
    };
  }

  let expires = decodeJwtExpiryMs(access);
  if (expires === null) {
    const stat = fs.statSync(codexAuthPath);
    expires = stat.mtimeMs + 60 * 60 * 1000;
  }

  const authStorePath = path.join(
    runtimeStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
  fs.writeFileSync(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access,
            refresh,
            expires,
            ...(typeof tokens?.account_id === "string" && tokens.account_id.trim()
              ? { accountId: tokens.account_id.trim() }
              : {}),
          },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.chmodSync(authStorePath, 0o600);

  return {
    ok: true,
    codexAuthPath,
    authStorePath,
  };
}

export function bootstrapTelegramLiveAcpValidationAuthStore(params) {
  return bootstrapTelegramLiveCodexAuthStore(params);
}

export function buildTelegramLiveRuntimeChildEnv(params) {
  const parentEnv =
    params?.parentEnv && typeof params.parentEnv === "object" ? params.parentEnv : process.env;
  const env = { ...parentEnv };
  const repoRoot =
    typeof params?.repoRoot === "string" && params.repoRoot.trim().length > 0
      ? path.resolve(params.repoRoot.trim())
      : process.cwd();

  // Detached tester lanes should boot only from their isolated runtime config
  // plus synced auth store. Raw host OpenAI env defaults reintroduce product
  // credentials/model routing behind our back, so strip them on entry.
  stripRawOpenAiEnvKeys(env);

  if (isTelegramLiveAcpValidationEnabled(params)) {
    // ACP validation lanes intentionally restart/repair the isolated runtime
    // while proving Telegram continuity. Persisted skip cutoffs can hide the
    // first fresh post-restart probe, so force this lane to re-ingest instead
    // of inheriting the prior runtime's offset watermark.
    env.OPENCLAW_TELEGRAM_IGNORE_PERSISTED_UPDATE_OFFSET = "1";

    const acpxExecutable = process.platform === "win32" ? "acpx.cmd" : "acpx";
    const acpxCandidatePaths = [
      path.join(repoRoot, "dist", "extensions", "acpx", "node_modules", ".bin", acpxExecutable),
      path.join(repoRoot, "extensions", "acpx", "node_modules", ".bin", acpxExecutable),
    ];
    const acpxCommand = acpxCandidatePaths.find((candidatePath) => fs.existsSync(candidatePath));

    // Direct ACPX fallback commands run through the agent shell, not the plugin
    // runtime backend. Seed the exact bundled/plugin-local binary path here so
    // the ACP lane never depends on a globally installed `acpx`, and keep the
    // fallback aligned with the dist skill bundle the model actually reads.
    if (acpxCommand) {
      const acpxBinDir = path.dirname(acpxCommand);
      env.ACPX_CMD = acpxCommand;
      env.PATH = env.PATH ? `${acpxBinDir}${path.delimiter}${env.PATH}` : acpxBinDir;
    }
  }

  return env;
}

function resolveTelegramTokenLeaseRoot(customRoot) {
  if (customRoot && String(customRoot).trim().length > 0) {
    return path.resolve(String(customRoot).trim());
  }
  return path.join(os.homedir(), ".openclaw", "telegram-token-leases");
}

function buildTelegramTokenLeasePath(params) {
  const token = String(params?.token ?? "").trim();
  const botId = token.includes(":") ? token.split(":", 1)[0] : "bot";
  return path.join(
    resolveTelegramTokenLeaseRoot(params?.leaseRoot),
    `${botId}-${hashTelegramToken(token)}.json`,
  );
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function collectActiveTelegramTokenLeaseEntries(params) {
  const tokens = normalizeTokenList(params?.tokens ?? []);
  const currentWorktreePath =
    params?.currentWorktreePath && String(params.currentWorktreePath).trim().length > 0
      ? path.resolve(String(params.currentWorktreePath))
      : null;
  const out = [];

  for (const token of tokens) {
    const leasePath = buildTelegramTokenLeasePath({
      token,
      leaseRoot: params?.leaseRoot,
    });
    if (!fs.existsSync(leasePath)) {
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    } catch {
      continue;
    }

    const pid = Number.parseInt(String(parsed?.pid ?? ""), 10);
    const worktreePath =
      typeof parsed?.worktree === "string" && parsed.worktree.trim()
        ? path.resolve(parsed.worktree.trim())
        : "";
    if (!Number.isFinite(pid) || pid <= 0 || !worktreePath || !isPidAlive(pid)) {
      continue;
    }
    if (currentWorktreePath && worktreePath === currentWorktreePath) {
      continue;
    }

    out.push({
      token,
      worktreePath,
      pid,
      accountId:
        typeof parsed?.accountId === "string" && parsed.accountId.trim()
          ? parsed.accountId.trim()
          : null,
    });
  }

  return normalizeLeaseEntries(out);
}

function execText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveListeningGatewayOwner(runtimePort) {
  // A stale claim is only safe to reclaim when the expected runtime port is not
  // actively owned by that worktree's gateway process anymore.
  const pidOutput = execText("lsof", ["-nP", `-tiTCP:${runtimePort}`, "-sTCP:LISTEN"]);
  const pids = pidOutput
    .split(/\r?\n/g)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (pids.length !== 1) {
    return { ok: false, reason: "runtime_not_running" };
  }

  const pid = pids[0];
  const cwdOutput = execText("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const worktreePath =
    cwdOutput
      .split(/\r?\n/g)
      .map((line) => (line.startsWith("n") ? line.slice(1).trim() : ""))
      .find(Boolean) ?? null;
  const command = execText("ps", ["-o", "command=", "-p", String(pid)]);
  const isGatewayProcess = Boolean(
    command && (command.includes(" gateway run") || command.includes("openclaw-gateway")),
  );

  if (!isGatewayProcess) {
    return { ok: false, reason: "runtime_listener_not_gateway", pid, worktreePath };
  }

  return {
    ok: true,
    pid,
    worktreePath,
  };
}

function canonicalizePath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function classifyTelegramTesterClaimEntries(params) {
  const claimedEntries = normalizeClaimEntries(params?.claimedEntries ?? []);
  const activeClaimEntries = [];
  const staleClaimEntries = [];

  for (const entry of claimedEntries) {
    // Worktree env files are just hints. The live runtime owner decides whether
    // a claim is still real or can be reclaimed.
    const profile = deriveTelegramLiveRuntimeProfile({ worktreePath: entry.worktreePath });
    const owner = resolveListeningGatewayOwner(profile.runtimePort);
    if (!owner.ok) {
      staleClaimEntries.push({
        ...entry,
        runtimePort: profile.runtimePort,
        reason: owner.reason,
      });
      continue;
    }
    if (
      owner.worktreePath &&
      canonicalizePath(owner.worktreePath) === canonicalizePath(entry.worktreePath)
    ) {
      activeClaimEntries.push({
        ...entry,
        runtimePort: profile.runtimePort,
        pid: owner.pid,
      });
      continue;
    }
    staleClaimEntries.push({
      ...entry,
      runtimePort: profile.runtimePort,
      pid: owner.pid,
      activeWorktreePath: owner.worktreePath ?? null,
      reason: "runtime_owned_elsewhere",
    });
  }

  return {
    activeClaimEntries,
    staleClaimEntries,
  };
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
  const acpValidation = isTelegramLiveAcpValidationEnabled(params);
  const portBase = Number.isFinite(params?.portBase) ? Number(params.portBase) : DEFAULT_PORT_BASE;
  const portRange =
    Number.isFinite(params?.portRange) && Number(params.portRange) > 0
      ? Number(params.portRange)
      : DEFAULT_PORT_RANGE;

  const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
  const profileId = `tg-live-${hash.slice(0, 10)}`;
  const hashInt = Number.parseInt(hash.slice(0, 8), 16);
  const runtimePort = portBase + (Number.isFinite(hashInt) ? hashInt % portRange : 0);
  // ACP validation must not reuse the default Telegram live state tree, or
  // stale auth/session artifacts can leak a different provider back in.
  const runtimeStateDir = acpValidation
    ? path.join(stateRoot, profileId, "acp-validation")
    : path.join(stateRoot, profileId);

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
  const leasedTokens = new Set(
    normalizeLeaseEntries(params?.leasedEntries ?? []).map((entry) => entry.token),
  );
  const currentToken = String(params?.currentToken ?? "").trim();

  if (poolTokens.length === 0) {
    return {
      ok: false,
      action: "fail",
      reason: "empty_pool",
      selectedToken: null,
    };
  }

  const isUnavailable = (token) =>
    claimedTokens.has(token) || reservedTokens.has(token) || leasedTokens.has(token);

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

export function summarizeTelegramTesterTokenPool(params) {
  const poolTokens = normalizeTokenList(params?.poolTokens ?? []);
  const classifiedClaimEntries = params?.activeClaimEntries
    ? normalizeClaimEntries(params.activeClaimEntries)
    : normalizeClaimEntries(params?.claimedEntries ?? []);
  const staleClaimEntries = normalizeClaimEntries(params?.staleClaimEntries ?? []);
  const leasedEntries = normalizeLeaseEntries(params?.leasedEntries ?? []);
  const claimedTokens = normalizeTokenList(classifiedClaimEntries.map((entry) => entry.token));
  const reservedTokens = normalizeTokenList(params?.reservedTokens ?? []);
  const currentToken = String(params?.currentToken ?? "").trim();
  const reservedTokenSet = new Set(reservedTokens);
  const claimedTokenSet = new Set(claimedTokens);
  const leasedTokenSet = new Set(leasedEntries.map((entry) => entry.token));

  // The selection layer needs one shared definition of "available" so
  // bootstrap, ensure, and diagnostics cannot drift into contradictory stories.
  const claimableTokens = poolTokens.filter(
    (token) =>
      !claimedTokenSet.has(token) && !reservedTokenSet.has(token) && !leasedTokenSet.has(token),
  );
  const selection = selectTelegramTesterToken({
    poolTokens,
    claimedTokens,
    leasedEntries,
    reservedTokens,
    currentToken,
  });

  let currentTokenStatus = "absent";
  if (currentToken) {
    if (!poolTokens.includes(currentToken)) {
      currentTokenStatus = "outside_pool";
    } else if (claimedTokenSet.has(currentToken)) {
      currentTokenStatus = "claimed_elsewhere";
    } else if (leasedTokenSet.has(currentToken)) {
      currentTokenStatus = "leased_elsewhere";
    } else if (reservedTokenSet.has(currentToken)) {
      currentTokenStatus = "reserved_by_base_config";
    } else {
      currentTokenStatus = "claimable";
    }
  }

  return {
    selection,
    poolTokens,
    poolCount: poolTokens.length,
    claimedEntries: classifiedClaimEntries,
    claimedTokens,
    claimedCount: classifiedClaimEntries.length,
    staleClaimEntries,
    staleClaimCount: staleClaimEntries.length,
    leasedEntries,
    leasedCount: leasedEntries.length,
    reservedTokens,
    reservedCount: reservedTokens.length,
    claimableTokens,
    claimableCount: claimableTokens.length,
    currentToken,
    currentTokenStatus,
  };
}
export function extractTelegramBotTokensFromConfig(config, opts = {}) {
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
      // Disabled canonical accounts are not started by the shared gateway, so
      // isolated runtimes may borrow those tokens safely.
      if (!opts.includeDisabledAccounts && "enabled" in entry && entry.enabled === false) {
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
  const acpValidation = isTelegramLiveAcpValidationEnabled(params);
  const fallbackWorkspaceDir =
    acpValidation &&
    typeof params?.worktreePath === "string" &&
    params.worktreePath.trim().length > 0
      ? path.resolve(params.worktreePath.trim())
      : null;
  const workspaceDir =
    typeof params?.workspaceDir === "string" && params.workspaceDir.trim().length > 0
      ? path.resolve(params.workspaceDir.trim())
      : fallbackWorkspaceDir;
  const dmPolicyOverride =
    typeof params?.dmPolicy === "string" && params.dmPolicy.trim().length > 0
      ? params.dmPolicy.trim()
      : null;
  const preferredModel = resolveTelegramLivePreferredModel(params);
  const baseConfig =
    params?.baseConfig && typeof params.baseConfig === "object"
      ? structuredClone(params.baseConfig)
      : {};

  if (!assignedToken || !Number.isFinite(runtimePort) || runtimePort <= 0) {
    throw new Error("Missing assigned token or runtime port.");
  }

  const config = baseConfig;
  scrubOpenAiSecretsFromTesterRuntimeConfig(config);
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
  const effectiveModel = sanitizeTelegramTesterModelSelection({
    preferredModel,
    currentModelConfig:
      typeof agentDefaults.model === "string" ||
      (agentDefaults.model && typeof agentDefaults.model === "object")
        ? agentDefaults.model
        : {},
  });
  if (workspaceDir) {
    agentDefaults.workspace = workspaceDir;
  }

  // Product config loading can inject default heartbeat settings later if this
  // block is absent. Mark tester lanes as explicitly disabled so they stay
  // quiet even when the product defaults evolve.
  agentDefaults.heartbeat = {
    ...(agentDefaults.heartbeat && typeof agentDefaults.heartbeat === "object"
      ? agentDefaults.heartbeat
      : {}),
    every: "0m",
    target: "none",
  };

  if (effectiveModel.effectiveModel) {
    const preferredModelTwin = codexTwinModelKey(effectiveModel.effectiveModel);
    const plainOpenAiTwin = codexTwinForPlainOpenAiModel(effectiveModel.effectiveModel);
    const inheritedPrimary = resolveConfiguredModelPrimary(defaultModel);
    const currentModelAllowlist =
      agentDefaults.models && typeof agentDefaults.models === "object" ? agentDefaults.models : {};
    const disallowedModelKeys = new Set(
      [
        preferredModelTwin,
        plainOpenAiTwin,
        preferredModel && inheritedPrimary !== effectiveModel.effectiveModel
          ? inheritedPrimary
          : "",
      ].filter(Boolean),
    );
    const nextModelAllowlist =
      disallowedModelKeys.size > 0
        ? Object.fromEntries(
            Object.entries(currentModelAllowlist).filter(
              ([key]) => !disallowedModelKeys.has(key.trim()),
            ),
          )
        : currentModelAllowlist;

    // Tester lanes need an explicit effective primary model plus a cleaned
    // allowlist. Preserve the OpenAI/Codex auth split by removing the plain
    // OpenAI twin whenever the effective selection is a Codex variant.
    agentDefaults.model = {
      ...defaultModel,
      primary: effectiveModel.effectiveModel,
      fallbacks: effectiveModel.fallbackModels,
    };
    if (disallowedModelKeys.size > 0) {
      agentDefaults.models = nextModelAllowlist;
    }
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

  if (acpValidation) {
    // ACP validation lanes intentionally exercise ACP continuity over Telegram,
    // so they must opt into acpx instead of inheriting the isolated default.
    config.acp = {
      backend: "acpx",
      enabled: true,
      dispatch: {
        enabled: true,
      },
    };
    // Validation lanes must also drop inherited non-Codex auth profiles, or
    // secrets precheck can still demand unrelated provider API keys.
    sanitizeTelegramLiveAcpValidationAuth(config);
  } else {
    // Telegram live tester lanes must stay isolated from ACP/acpx because the
    // base config may otherwise auto-enable ACP before Telegram can reply.
    config.acp = {
      enabled: false,
      dispatch: {
        enabled: false,
      },
    };
  }

  config.plugins = {
    ...basePlugins,
    enabled: true,
    allow: acpValidation ? ["telegram", "acpx"] : ["telegram"],
    // The isolated Telegram live harness runs bundled Telegram only. Inherited
    // deny entries from the founder config can reference plugins unavailable in
    // the current checkout, which makes doctor reject the runtime before it
    // even boots. Keep the default denylist to the one thing we intentionally
    // block, and remove that block only for explicit ACP validation lanes.
    deny: acpValidation ? [] : ["acpx"],
    entries: {
      telegram: {
        ...(pluginEntries.telegram && typeof pluginEntries.telegram === "object"
          ? pluginEntries.telegram
          : {}),
        enabled: true,
      },
      acpx: {
        ...(pluginEntries.acpx && typeof pluginEntries.acpx === "object" ? pluginEntries.acpx : {}),
        enabled: acpValidation,
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

export function pruneTesterRuntimeAuthStore(params) {
  const modelProvider =
    resolveModelProvider(params?.preferredModel) || resolveModelProvider(params?.defaultModel);
  const sourceStore =
    params?.store && typeof params.store === "object" && !Array.isArray(params.store)
      ? structuredClone(params.store)
      : { version: 1, profiles: {} };

  if (!sourceStore.profiles || typeof sourceStore.profiles !== "object") {
    sourceStore.profiles = {};
  }

  if (!modelProvider) {
    return sourceStore;
  }

  const keptProfileIds = new Set();
  const nextProfiles = {};
  for (const [profileId, credential] of Object.entries(sourceStore.profiles)) {
    const provider = normalizeProviderId(credential?.provider);
    if (provider !== modelProvider) {
      continue;
    }
    keptProfileIds.add(profileId);
    nextProfiles[profileId] = credential;
  }

  const pruneRecord = (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return undefined;
    }
    const entries = Object.entries(record).filter(([key]) => keptProfileIds.has(key));
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  const pruneOrder = (order) => {
    if (!order || typeof order !== "object" || Array.isArray(order)) {
      return undefined;
    }
    const next = {};
    for (const [provider, profileIds] of Object.entries(order)) {
      if (normalizeProviderId(provider) !== modelProvider || !Array.isArray(profileIds)) {
        continue;
      }
      const kept = profileIds.filter((profileId) => keptProfileIds.has(String(profileId)));
      if (kept.length > 0) {
        next[provider] = kept;
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const pruneLastGood = (lastGood) => {
    if (!lastGood || typeof lastGood !== "object" || Array.isArray(lastGood)) {
      return undefined;
    }
    const next = {};
    for (const [provider, profileId] of Object.entries(lastGood)) {
      if (
        normalizeProviderId(provider) !== modelProvider ||
        !keptProfileIds.has(String(profileId))
      ) {
        continue;
      }
      next[provider] = profileId;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  return {
    version: Number.isFinite(sourceStore.version) ? sourceStore.version : 1,
    profiles: nextProfiles,
    order: pruneOrder(sourceStore.order),
    lastGood: pruneLastGood(sourceStore.lastGood),
    usageStats: pruneRecord(sourceStore.usageStats),
  };
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
