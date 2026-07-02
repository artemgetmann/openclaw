import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copySanitizedTesterTtsPreferences } from "./worktree-tester-baseline.mjs";

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

  // ACP validation is a special transport-continuity lane. Normal tester lanes
  // must inherit the main runtime model unless the operator explicitly
  // overrides it, or tester proof stops being staging proof.
  if (isTelegramLiveAcpValidationEnabled(params)) {
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

function claudeCliAdvancedTesterModels(model) {
  const trimmed = String(model ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (lower === "claude-cli/sonnet" || lower === "claude-cli/sonnet[1m]") {
    return ["claude-cli/sonnet", "claude-cli/sonnet[1m]"];
  }
  if (lower === "claude-cli/opus" || lower === "claude-cli/opus[1m]") {
    return ["claude-cli/opus", "claude-cli/opus[1m]"];
  }
  return trimmed ? [trimmed] : [];
}

function ensureTesterModelAllowlistEntries(allowlist, modelRefs) {
  const next = { ...(allowlist && typeof allowlist === "object" ? allowlist : {}) };
  for (const modelRef of normalizeStringList(modelRefs)) {
    if (!next[modelRef]) {
      next[modelRef] = {};
    }
  }
  return next;
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

  if (preferredModel) {
    return {
      effectiveModel: preferredModel,
      fallbackModels: [],
    };
  }

  // Parity lanes preserve the main runtime model/provider selection. Secret
  // material is scrubbed elsewhere; changing provider here makes a tester pass
  // irrelevant to the main Jarvis runtime.
  if (inheritedPrimary) {
    return {
      effectiveModel: inheritedPrimary,
      fallbackModels: inheritedFallbacks,
    };
  }

  const safeInheritedFallback = inheritedFallbacks[0] ?? "";
  if (safeInheritedFallback) {
    return {
      effectiveModel: safeInheritedFallback,
      fallbackModels: inheritedFallbacks.filter((model) => model !== safeInheritedFallback),
    };
  }

  return {
    effectiveModel: "",
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

function resolveCodexKeychainAccount(codexHome) {
  let keychainHome = codexHome;
  try {
    keychainHome = fs.realpathSync.native(codexHome);
  } catch {
    // Missing CODEX_HOME is still a valid lookup input; the Codex CLI uses the
    // path string when deriving the account hash, so keep the unresolved value.
  }
  const hash = crypto.createHash("sha256").update(keychainHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function resolveTelegramLiveSeedStateDir(seedStateDir) {
  const configured = String(
    seedStateDir ?? process.env.OPENCLAW_TELEGRAM_LIVE_MEMORY_SEED_STATE_DIR ?? "",
  ).trim();
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveDefaultTelegramLiveStateRoot() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "OpenClaw",
    "telegram-live-worktrees",
  );
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePrivateJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Best-effort privacy hardening; the rename below is the durable write.
  }
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Existing platforms/filesystems may not support chmod. The file contents
    // are non-secret sender IDs, so this should not block the preflight.
  }
}

function isPathInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isTelegramLiveIsolatedRuntimeProfile(params) {
  const runtimeStateDir = String(params?.runtimeStateDir ?? "").trim();
  const runtimeConfigPath = String(params?.runtimeConfigPath ?? "").trim();
  if (!runtimeStateDir || !runtimeConfigPath) {
    return false;
  }

  const stateDir = path.resolve(runtimeStateDir);
  const configPath = path.resolve(runtimeConfigPath);
  if (configPath !== path.join(stateDir, "openclaw.telegram-live.json")) {
    return false;
  }

  const stateRoot =
    typeof params?.stateRoot === "string" && params.stateRoot.trim().length > 0
      ? path.resolve(params.stateRoot.trim())
      : resolveDefaultTelegramLiveStateRoot();
  if (!isPathInside(stateRoot, stateDir)) {
    return false;
  }

  const relativeParts = path.relative(stateRoot, stateDir).split(path.sep).filter(Boolean);
  const profileId = relativeParts[0] ?? "";
  if (!/^tg-live-[a-f0-9]{10}$/u.test(profileId)) {
    return false;
  }

  // Default tester profiles use <root>/<profile>/.openclaw. ACP validation
  // profiles use <root>/<profile>/acp-validation. Both are isolated tester
  // state trees; shared app state never matches this shape.
  return (
    relativeParts.length === 2 &&
    (relativeParts[1] === ".openclaw" || relativeParts[1] === "acp-validation")
  );
}

function resolveRuntimeTelegramDmPolicy(config) {
  const telegram = config?.channels?.telegram;
  const policy =
    telegram && typeof telegram === "object" && typeof telegram.dmPolicy === "string"
      ? telegram.dmPolicy.trim().toLowerCase()
      : "";
  return policy || "pairing";
}

export function resolveTelegramLiveModelAuthProbe(params) {
  const runtimeConfigPath = String(params?.runtimeConfigPath ?? "").trim();
  if (!runtimeConfigPath || !fs.existsSync(runtimeConfigPath)) {
    return {
      required: false,
      reason: "runtime_config_missing",
      model: "",
      provider: "",
      profile: "",
    };
  }

  const config = readJsonObject(runtimeConfigPath);
  const modelConfig = config?.agents?.defaults?.model;
  const model =
    typeof modelConfig === "string"
      ? modelConfig.trim()
      : modelConfig && typeof modelConfig === "object" && typeof modelConfig.primary === "string"
        ? modelConfig.primary.trim()
        : "";
  const slashIndex = model.indexOf("/");
  const provider = slashIndex > 0 ? model.slice(0, slashIndex).trim().toLowerCase() : "";

  if (!provider) {
    return {
      required: false,
      reason: "model_unresolved",
      model,
      provider,
      profile: "",
    };
  }

  return {
    required: true,
    reason: provider === "openai-codex" ? "codex_model_selected" : "model_provider_selected",
    model,
    provider,
    // Codex tester auth is bootstrapped into this deterministic profile. Other
    // providers may have user-named profiles, so probe all profiles for that
    // provider instead of guessing "<provider>:default".
    profile: provider === "openai-codex" ? "openai-codex:default" : "",
  };
}

export function ensureTelegramLiveSenderAccess(params) {
  const runtimeStateDir = String(params?.runtimeStateDir ?? "").trim();
  const runtimeConfigPath = String(params?.runtimeConfigPath ?? "").trim();
  const senderId = String(params?.senderId ?? "").trim();
  if (!senderId) {
    return {
      ok: false,
      status: "sender_missing",
      reason: "telegram_user_id_missing",
      senderId: "",
      storePath: "",
    };
  }
  if (
    !isTelegramLiveIsolatedRuntimeProfile({
      runtimeStateDir,
      runtimeConfigPath,
      stateRoot: params?.stateRoot,
    })
  ) {
    return {
      ok: false,
      status: "unsafe_runtime_profile",
      reason: "runtime_state_not_isolated_telegram_live_profile",
      senderId,
      storePath: "",
    };
  }

  const config = readJsonObject(runtimeConfigPath);
  const dmPolicy = resolveRuntimeTelegramDmPolicy(config);
  if (dmPolicy === "open") {
    return {
      ok: true,
      status: "open",
      reason: "dmPolicy=open",
      senderId,
      storePath: "",
    };
  }
  if (dmPolicy !== "pairing") {
    return {
      ok: false,
      status: "unsupported_dm_policy",
      reason: `dmPolicy=${dmPolicy}`,
      senderId,
      storePath: "",
    };
  }

  const storePath = path.join(runtimeStateDir, "credentials", "telegram-default-allowFrom.json");
  const store = readJsonObject(storePath);
  const current = Array.isArray(store.allowFrom)
    ? store.allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (current.includes(senderId)) {
    return {
      ok: true,
      status: "present",
      reason: "sender_already_allowed",
      senderId,
      storePath,
    };
  }

  writePrivateJsonFile(storePath, {
    version: 1,
    allowFrom: [...current, senderId],
  });
  return {
    ok: true,
    status: "added",
    reason: "sender_added_to_isolated_pairing_store",
    senderId,
    storePath,
  };
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // Best-effort privacy hardening; copy success is the important invariant.
    }
  }
}

export function syncTelegramLiveRuntimeMemoryStore(params = {}) {
  const runtimeStateDir = String(params?.runtimeStateDir ?? "").trim();
  if (!runtimeStateDir) {
    return { copied: false, reason: "missing_runtime_state_dir" };
  }

  const sourceStateDir = resolveTelegramLiveSeedStateDir(params?.sourceStateDir);
  const sourceMemoryDir = path.join(sourceStateDir, "memory");
  const targetMemoryDir = path.join(path.resolve(runtimeStateDir), "memory");

  if (!fs.existsSync(sourceMemoryDir)) {
    return {
      copied: false,
      reason: "missing_source",
      sourceMemoryDir,
      targetMemoryDir,
    };
  }

  // Replace the isolated snapshot before boot so a prior empty tester DB cannot
  // shadow the real seed. The source is never opened for writes by this helper.
  fs.rmSync(targetMemoryDir, { recursive: true, force: true });
  copyDirectoryContents(sourceMemoryDir, targetMemoryDir);

  return {
    copied: true,
    sourceMemoryDir,
    targetMemoryDir,
  };
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

function hashCodexTokenMaterial(access, refresh) {
  return crypto.createHash("sha256").update(`${access}\u0000${refresh}`).digest("hex");
}

function buildCodexCredentialFromTokens(tokens, params) {
  const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!access || !refresh) {
    return null;
  }

  const nowMs = Number.isFinite(Number(params?.nowMs)) ? Number(params.nowMs) : Date.now();
  const jwtExpiryMs = decodeJwtExpiryMs(access);
  const accessExpiryMs =
    jwtExpiryMs ??
    (Number.isFinite(Number(params?.fallbackExpiryMs))
      ? Number(params.fallbackExpiryMs)
      : nowMs + 60 * 60 * 1000);

  return {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires: accessExpiryMs,
    ...(typeof tokens?.account_id === "string" && tokens.account_id.trim()
      ? { accountId: tokens.account_id.trim() }
      : {}),
  };
}

function readCodexAuthJsonCandidate(params = {}) {
  const codexHome = resolveCodexHomePath(params.codexHome);
  const codexAuthPath = path.join(codexHome, "auth.json");
  const validation = validateLocalCodexAuth(params);
  if (!validation.ok) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
    const credential = buildCodexCredentialFromTokens(raw?.tokens, {
      ...params,
      fallbackExpiryMs: validation.accessExpiryMs,
    });
    if (!credential) {
      return null;
    }
    return {
      kind: "codex_cli",
      sourceKind: "codex_cli_auth_json",
      sourcePath: codexAuthPath,
      profileId: "openai-codex:default",
      credential,
      accessExpiryMs: validation.accessExpiryMs,
      expirySource: validation.expirySource,
      tokenMaterialHash: hashCodexTokenMaterial(credential.access, credential.refresh),
    };
  } catch {
    return null;
  }
}

function readCodexKeychainCandidate(params = {}) {
  const platform = params?.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }

  const execFileSyncImpl = params?.execFileSync ?? execFileSync;
  const codexHome = resolveCodexHomePath(params.codexHome);
  const account = resolveCodexKeychainAccount(codexHome);
  try {
    const secret = execFileSyncImpl(
      "security",
      ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const parsed = JSON.parse(secret);
    const lastRefreshRaw = parsed?.last_refresh;
    const lastRefreshMs =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : NaN;
    const fallbackExpiryMs = Number.isFinite(lastRefreshMs)
      ? lastRefreshMs + 60 * 60 * 1000
      : Date.now() + 60 * 60 * 1000;
    const credential = buildCodexCredentialFromTokens(parsed?.tokens, {
      ...params,
      fallbackExpiryMs,
    });
    if (!credential) {
      return null;
    }
    return {
      kind: "codex_cli",
      sourceKind: "codex_cli_keychain",
      sourcePath: "macos-keychain:Codex Auth",
      profileId: "openai-codex:default",
      credential,
      accessExpiryMs: credential.expires,
      expirySource:
        decodeJwtExpiryMs(credential.access) === null ? "keychain_last_refresh" : "jwt_exp",
      tokenMaterialHash: hashCodexTokenMaterial(credential.access, credential.refresh),
    };
  } catch {
    return null;
  }
}

function writeCodexCredentialAuthStore(params) {
  const runtimeStateDir = path.resolve(String(params?.runtimeStateDir ?? ""));
  const agentId = String(params?.agentId ?? "main").trim() || "main";
  const credential = params?.credential;
  const targetAuthPath = path.join(
    runtimeStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );

  fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });
  fs.writeFileSync(
    targetAuthPath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": credential,
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
  fs.chmodSync(targetAuthPath, 0o600);
  return targetAuthPath;
}

export function validateLocalCodexAuth(params = {}) {
  const codexHome = resolveCodexHomePath(params.codexHome);
  const codexAuthPath = path.join(codexHome, "auth.json");
  const nearExpiryWindowMs = Number.isFinite(Number(params.nearExpiryWindowMs))
    ? Math.max(0, Number(params.nearExpiryWindowMs))
    : 5 * 60 * 1000;
  const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();

  if (!fs.existsSync(codexAuthPath)) {
    return {
      ok: false,
      reason: "codex_auth_missing",
      codexAuthPath,
      hasAccessToken: false,
      hasRefreshToken: false,
      accessExpiryMs: null,
      expirySource: "missing",
    };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
  } catch {
    return {
      ok: false,
      reason: "codex_auth_invalid",
      codexAuthPath,
      hasAccessToken: false,
      hasRefreshToken: false,
      accessExpiryMs: null,
      expirySource: "unreadable",
    };
  }

  const tokens = raw && typeof raw === "object" ? raw.tokens : null;
  const access = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!access || !refresh) {
    return {
      ok: false,
      reason: "codex_auth_invalid",
      codexAuthPath,
      hasAccessToken: Boolean(access),
      hasRefreshToken: Boolean(refresh),
      accessExpiryMs: null,
      expirySource: "token_presence",
    };
  }

  const jwtExpiryMs = decodeJwtExpiryMs(access);
  if (jwtExpiryMs !== null && jwtExpiryMs <= nowMs + nearExpiryWindowMs) {
    return {
      ok: false,
      reason: "codex_auth_expired",
      codexAuthPath,
      hasAccessToken: true,
      hasRefreshToken: true,
      accessExpiryMs: jwtExpiryMs,
      expirySource: "jwt_exp",
    };
  }

  if (jwtExpiryMs !== null) {
    return {
      ok: true,
      reason: "ok",
      codexAuthPath,
      hasAccessToken: true,
      hasRefreshToken: true,
      accessExpiryMs: jwtExpiryMs,
      expirySource: "jwt_exp",
    };
  }

  // Older Codex auth files may store opaque access tokens. Preserve the prior
  // mtime-based freshness behavior for those files, but make the source visible
  // so shell proof can explain why this is a weaker validation path.
  const stat = fs.statSync(codexAuthPath);
  return {
    ok: true,
    reason: "ok",
    codexAuthPath,
    hasAccessToken: true,
    hasRefreshToken: true,
    accessExpiryMs: stat.mtimeMs + 60 * 60 * 1000,
    expirySource: "mtime_fallback",
  };
}

export function isLocalCodexAuthAvailable(params = {}) {
  return validateLocalCodexAuth(params).ok;
}

export function bootstrapTelegramLiveCodexAuthStore(params) {
  const runtimeStateDir = path.resolve(String(params?.runtimeStateDir ?? ""));
  const agentId = String(params?.agentId ?? "main").trim() || "main";
  if (!runtimeStateDir) {
    throw new Error("Missing runtimeStateDir for Telegram Codex auth bootstrap.");
  }

  const codexHome = resolveCodexHomePath(params?.codexHome);
  const codexAuthPath = path.join(codexHome, "auth.json");
  const authStorePath = path.join(
    runtimeStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  const validation = validateLocalCodexAuth(params);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      codexAuthPath,
      authStorePath,
      expirySource: validation.expirySource,
      accessExpiryMs: validation.accessExpiryMs,
    };
  }

  const candidate = readCodexAuthJsonCandidate(params);
  if (!candidate) {
    return {
      ok: false,
      reason: "codex_auth_invalid",
      codexAuthPath,
      authStorePath,
      expirySource: validation.expirySource,
      accessExpiryMs: validation.accessExpiryMs,
    };
  }
  writeCodexCredentialAuthStore({
    runtimeStateDir,
    agentId,
    credential: candidate.credential,
  });

  return {
    ok: true,
    codexAuthPath,
    authStorePath,
    expirySource: validation.expirySource,
    accessExpiryMs: validation.accessExpiryMs,
  };
}

function validateOpenClawCodexAuthProfile(credential, params = {}) {
  if (!credential || typeof credential !== "object") {
    return { ok: false, reason: "invalid_profile" };
  }
  const provider = normalizeProviderId(credential.provider);
  if (provider !== "openai-codex") {
    return { ok: false, reason: "wrong_provider" };
  }
  const access =
    typeof credential.access === "string"
      ? credential.access.trim()
      : typeof credential.token === "string"
        ? credential.token.trim()
        : "";
  const refresh = typeof credential.refresh === "string" ? credential.refresh.trim() : "";
  if (!access || (credential.type === "oauth" && !refresh)) {
    return { ok: false, reason: "missing_token" };
  }

  const nearExpiryWindowMs = Number.isFinite(Number(params.nearExpiryWindowMs))
    ? Math.max(0, Number(params.nearExpiryWindowMs))
    : 5 * 60 * 1000;
  const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();
  const explicitExpiry = Number(credential.expires);
  const jwtExpiryMs = decodeJwtExpiryMs(access);
  // Prefer OpenClaw's persisted OAuth expiry when present; fall back to JWT
  // introspection for imported CLI-shaped tokens.
  const accessExpiryMs =
    Number.isFinite(explicitExpiry) && explicitExpiry > 0 ? explicitExpiry : jwtExpiryMs;
  if (accessExpiryMs !== null && accessExpiryMs <= nowMs + nearExpiryWindowMs) {
    return { ok: false, reason: "expired", accessExpiryMs };
  }

  return {
    ok: true,
    reason: "ok",
    accessExpiryMs,
    expirySource:
      Number.isFinite(explicitExpiry) && explicitExpiry > 0 ? "profile_expires" : "jwt_exp",
  };
}

function isCandidateExpired(candidate, params = {}) {
  const nearExpiryWindowMs = Number.isFinite(Number(params.nearExpiryWindowMs))
    ? Math.max(0, Number(params.nearExpiryWindowMs))
    : 5 * 60 * 1000;
  const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();
  const accessExpiryMs = Number(candidate?.accessExpiryMs);
  return Number.isFinite(accessExpiryMs) && accessExpiryMs <= nowMs + nearExpiryWindowMs;
}

function candidateExpiryScore(candidate) {
  const accessExpiryMs = Number(candidate?.accessExpiryMs);
  return Number.isFinite(accessExpiryMs) ? accessExpiryMs : Number.NEGATIVE_INFINITY;
}

function shouldPreferCodexAuthCandidate(candidate, current) {
  if (!current) {
    return true;
  }

  const candidateExpiry = candidateExpiryScore(candidate);
  const currentExpiry = candidateExpiryScore(current);
  if (candidateExpiry > currentExpiry) {
    return true;
  }
  if (candidateExpiry < currentExpiry) {
    return false;
  }

  // Jarvis/OpenClaw auth stores stay the default on a true tie. The exception is
  // Codex CLI OAuth rotation: equal access expiry with different token material
  // means the local CLI has a different refresh token tuple and is safer to seed.
  return (
    candidate.kind === "codex_cli" &&
    current.kind !== "codex_cli" &&
    candidate.tokenMaterialHash !== current.tokenMaterialHash
  );
}

export function readUsableOpenClawCodexAuthStore(params = {}) {
  const authStorePath = String(params?.authStorePath ?? "").trim();
  if (!authStorePath || !fs.existsSync(authStorePath)) {
    return { ok: false, reason: "missing_auth_store", authStorePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authStorePath, "utf8"));
  } catch {
    return { ok: false, reason: "invalid_auth_store", authStorePath };
  }

  const profiles = parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
  const codexProfiles = Object.entries(profiles).filter(([, credential]) => {
    return normalizeProviderId(credential?.provider) === "openai-codex";
  });
  if (codexProfiles.length === 0) {
    return { ok: false, reason: "missing_codex_profile", authStorePath };
  }

  const usableProfileIds = [];
  let selectedProfile = null;
  for (const [profileId, credential] of codexProfiles) {
    const validation = validateOpenClawCodexAuthProfile(credential, params);
    if (validation.ok) {
      usableProfileIds.push(profileId);
      const access = typeof credential.access === "string" ? credential.access : credential.token;
      const refresh = typeof credential.refresh === "string" ? credential.refresh : "";
      const candidate = {
        kind: "openclaw_auth_store",
        sourceKind: "openclaw_auth_store",
        sourcePath: authStorePath,
        profileId,
        credential,
        accessExpiryMs: validation.accessExpiryMs,
        expirySource: validation.expirySource,
        tokenMaterialHash: hashCodexTokenMaterial(access, refresh),
      };
      if (shouldPreferCodexAuthCandidate(candidate, selectedProfile)) {
        selectedProfile = candidate;
      }
    }
  }
  if (usableProfileIds.length === 0) {
    return { ok: false, reason: "no_usable_codex_profile", authStorePath };
  }

  return {
    ok: true,
    authStorePath,
    // Import only Codex profiles into Codex-pinned tester lanes. Pulling the
    // whole shared store back in can reintroduce Anthropic/Google fallbacks.
    store: pruneTesterRuntimeAuthStore({
      store: parsed,
      preferredModel: params?.preferredModel ?? "openai-codex/gpt-5.4",
    }),
    profileCount: usableProfileIds.length,
    profileIds: usableProfileIds,
    selectedProfileId: selectedProfile?.profileId,
    accessExpiryMs: selectedProfile?.accessExpiryMs ?? null,
    expirySource: selectedProfile?.expirySource ?? "unknown",
    tokenMaterialHash: selectedProfile?.tokenMaterialHash,
  };
}

function copyOpenClawCodexAuthStore(params) {
  const runtimeStateDir = path.resolve(String(params?.runtimeStateDir ?? ""));
  const agentId = String(params?.agentId ?? "main").trim() || "main";
  const source = readUsableOpenClawCodexAuthStore(params);
  if (!source.ok) {
    return source;
  }

  const targetAuthPath = path.join(
    runtimeStateDir,
    "agents",
    agentId,
    "agent",
    "auth-profiles.json",
  );
  fs.mkdirSync(path.dirname(targetAuthPath), { recursive: true });
  fs.writeFileSync(targetAuthPath, `${JSON.stringify(source.store, null, 2)}\n`, "utf8");
  fs.chmodSync(targetAuthPath, 0o600);

  return {
    ok: true,
    reason: "ok",
    sourceAuthPath: source.authStorePath,
    authStorePath: targetAuthPath,
    profileCount: source.profileCount,
    profileIds: source.profileIds,
    selectedProfileId: source.selectedProfileId,
    accessExpiryMs: source.accessExpiryMs,
    expirySource: source.expirySource,
  };
}

function collectTelegramLiveCodexAuthCandidates(params = {}) {
  const candidates = [];
  const sourceAuthPaths = normalizeStringList(params?.sourceAuthPaths ?? []);

  for (const authStorePath of sourceAuthPaths) {
    const source = readUsableOpenClawCodexAuthStore({
      ...params,
      authStorePath,
    });
    if (source.ok) {
      candidates.push({
        kind: "openclaw_auth_store",
        sourceKind: "openclaw_auth_store",
        sourcePath: source.authStorePath,
        profileId: source.selectedProfileId,
        accessExpiryMs: source.accessExpiryMs,
        expirySource: source.expirySource,
        tokenMaterialHash: source.tokenMaterialHash,
        source,
      });
    }
  }

  for (const candidate of [
    readCodexKeychainCandidate(params),
    readCodexAuthJsonCandidate(params),
  ]) {
    if (candidate && !isCandidateExpired(candidate, params)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function bootstrapTelegramLiveCodexAuthStoreFromSources(params = {}) {
  const runtimeStateDir = path.resolve(String(params?.runtimeStateDir ?? ""));
  const agentId = String(params?.agentId ?? "main").trim() || "main";
  const candidates = collectTelegramLiveCodexAuthCandidates(params);
  let selected = null;
  for (const candidate of candidates) {
    if (shouldPreferCodexAuthCandidate(candidate, selected)) {
      selected = candidate;
    }
  }

  if (!selected) {
    const codexBootstrap = bootstrapTelegramLiveCodexAuthStore({
      ...params,
      runtimeStateDir,
      agentId,
    });
    return {
      ...codexBootstrap,
      sourceKind: "codex_cli_auth_json",
      candidateCount: 0,
    };
  }

  if (selected.kind === "openclaw_auth_store") {
    const copied = copyOpenClawCodexAuthStore({
      ...params,
      authStorePath: selected.sourcePath,
      runtimeStateDir,
      agentId,
    });
    return {
      ...copied,
      sourceKind: selected.sourceKind,
      sourceAuthPath: selected.sourcePath,
      selectedProfileId: selected.profileId,
      accessExpiryMs: selected.accessExpiryMs,
      expirySource: selected.expirySource,
      candidateCount: candidates.length,
    };
  }

  const authStorePath = writeCodexCredentialAuthStore({
    runtimeStateDir,
    agentId,
    credential: selected.credential,
  });
  return {
    ok: true,
    reason: "ok",
    sourceKind: selected.sourceKind,
    codexAuthPath: selected.sourcePath,
    authStorePath,
    selectedProfileId: selected.profileId,
    accessExpiryMs: selected.accessExpiryMs,
    expirySource: selected.expirySource,
    candidateCount: candidates.length,
  };
}

export function bootstrapTelegramLiveAcpValidationAuthStore(params) {
  return bootstrapTelegramLiveCodexAuthStoreFromSources(params);
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
  // ACPX_CMD is only valid for ACP validation lanes; default tester lanes must
  // not inherit a host shell override that points at the wrong runtime.
  delete env.ACPX_CMD;

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
  const hasCustomStateRoot = params?.stateRoot && String(params.stateRoot).trim().length > 0;
  const stateRoot = hasCustomStateRoot
    ? path.resolve(String(params.stateRoot))
    : resolveDefaultTelegramLiveStateRoot();
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
    : hasCustomStateRoot
      ? path.join(stateRoot, profileId)
      : path.join(stateRoot, profileId, ".openclaw");

  return {
    worktreePath,
    profileId,
    runtimePort,
    runtimeStateDir,
  };
}

export function syncTelegramLiveRuntimeTtsPreferences(params) {
  return copySanitizedTesterTtsPreferences({
    sourceStateDir: params?.baselineStateDir,
    targetStateDir: params?.runtimeStateDir,
  });
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
  const gatewayAuthToken = String(params?.gatewayAuthToken ?? "").trim();
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
  const runtimeStateDir =
    typeof params?.runtimeStateDir === "string" && params.runtimeStateDir.trim().length > 0
      ? path.resolve(params.runtimeStateDir.trim())
      : null;
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
  const gatewayAuth = gateway.auth && typeof gateway.auth === "object" ? gateway.auth : {};
  const effectiveGatewayAuthToken =
    gatewayAuthToken || (typeof gatewayAuth.token === "string" ? gatewayAuth.token.trim() : "");
  const controlUi =
    gateway.controlUi && typeof gateway.controlUi === "object" ? gateway.controlUi : {};
  config.gateway = {
    ...gateway,
    port: runtimePort,
    bind: "loopback",
    mode: "local",
    reload: {
      ...(gateway.reload && typeof gateway.reload === "object" ? gateway.reload : {}),
      mode: "off",
    },
    ...(effectiveGatewayAuthToken
      ? {
          auth: {
            ...gatewayAuth,
            token: effectiveGatewayAuthToken,
          },
        }
      : {}),
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
  if (runtimeStateDir) {
    const memorySearch =
      agentDefaults.memorySearch && typeof agentDefaults.memorySearch === "object"
        ? structuredClone(agentDefaults.memorySearch)
        : {};
    const memorySearchStore =
      memorySearch.store && typeof memorySearch.store === "object" ? memorySearch.store : {};
    agentDefaults.memorySearch = {
      ...memorySearch,
      store: {
        ...memorySearchStore,
        path: path.join(runtimeStateDir, "memory", "{agentId}.sqlite"),
      },
    };
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
    const cleanedModelAllowlist =
      disallowedModelKeys.size > 0
        ? Object.fromEntries(
            Object.entries(currentModelAllowlist).filter(
              ([key]) => !disallowedModelKeys.has(key.trim()),
            ),
          )
        : currentModelAllowlist;
    const nextModelAllowlist = ensureTesterModelAllowlistEntries(cleanedModelAllowlist, [
      effectiveModel.effectiveModel,
      ...effectiveModel.fallbackModels,
      ...claudeCliAdvancedTesterModels(effectiveModel.effectiveModel),
    ]);

    // Tester lanes need an explicit effective primary model plus a cleaned
    // allowlist. Preserve the OpenAI/Codex auth split by removing the plain
    // OpenAI twin whenever the effective selection is a Codex variant.
    agentDefaults.model = {
      ...defaultModel,
      primary: effectiveModel.effectiveModel,
      fallbacks: effectiveModel.fallbackModels,
    };
    agentDefaults.models = nextModelAllowlist;
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
    // Keep the plugin/tool surface aligned with the base runtime. The tester
    // lane isolates transport credentials and state, not product capability.
    allow: Array.isArray(basePlugins.allow) ? structuredClone(basePlugins.allow) : undefined,
    deny: Array.isArray(basePlugins.deny) ? structuredClone(basePlugins.deny) : undefined,
    entries: {
      ...structuredClone(pluginEntries),
      telegram: {
        ...(pluginEntries.telegram && typeof pluginEntries.telegram === "object"
          ? structuredClone(pluginEntries.telegram)
          : {}),
        enabled: true,
      },
      ...(acpValidation
        ? {
            acpx: {
              ...(pluginEntries.acpx && typeof pluginEntries.acpx === "object"
                ? structuredClone(pluginEntries.acpx)
                : {}),
              enabled: true,
            },
          }
        : {}),
    },
    slots: {
      ...structuredClone(pluginSlots),
    },
  };

  config.tools = baseTools;

  return config;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stableJson(value[key])]),
  );
}

function jsonEqual(a, b) {
  return JSON.stringify(stableJson(a ?? null)) === JSON.stringify(stableJson(b ?? null));
}

function normalizePluginSlotsForParity(slots) {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
    return {};
  }
  return slots;
}

function normalizeTesterModelAllowlistForParity(modelConfig, models) {
  const allowlist = models && typeof models === "object" && !Array.isArray(models) ? models : {};
  const primary = resolveConfiguredModelPrimary(modelConfig);
  const prunedTwin = codexTwinModelKey(primary) || codexTwinForPlainOpenAiModel(primary) || "";

  if (!prunedTwin || !Object.prototype.hasOwnProperty.call(allowlist, prunedTwin)) {
    return allowlist;
  }

  return Object.fromEntries(Object.entries(allowlist).filter(([key]) => key !== prunedTwin));
}

function resolveConfigValue(config, dottedPath) {
  let current = config;
  for (const segment of dottedPath.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectExistingSessionProfiles(config) {
  const profiles =
    config?.browser?.profiles && typeof config.browser.profiles === "object"
      ? config.browser.profiles
      : {};
  return Object.entries(profiles)
    .filter(([, profile]) => {
      return profile && typeof profile === "object" && profile.driver === "existing-session";
    })
    .map(([name]) => name)
    .toSorted();
}

export function buildTelegramLiveRuntimeParityReport(params = {}) {
  const baseConfigPath = String(params.baseConfigPath ?? "").trim();
  const runtimeConfigPath = String(params.runtimeConfigPath ?? "").trim();
  const baseConfig = baseConfigPath ? readJsonObject(baseConfigPath) : {};
  const runtimeConfig = runtimeConfigPath ? readJsonObject(runtimeConfigPath) : {};
  const parityPaths = [
    "agents.defaults.model",
    "agents.defaults.models",
    "browser",
    "plugins.allow",
    "plugins.deny",
    "plugins.slots",
    "tools",
  ];
  const unexpectedDiffs = parityPaths.filter((pathKey) => {
    if (pathKey === "plugins.slots") {
      return !jsonEqual(
        normalizePluginSlotsForParity(resolveConfigValue(baseConfig, pathKey)),
        normalizePluginSlotsForParity(resolveConfigValue(runtimeConfig, pathKey)),
      );
    }
    if (pathKey === "agents.defaults.models") {
      return !jsonEqual(
        normalizeTesterModelAllowlistForParity(
          resolveConfigValue(baseConfig, "agents.defaults.model"),
          resolveConfigValue(baseConfig, pathKey),
        ),
        normalizeTesterModelAllowlistForParity(
          resolveConfigValue(runtimeConfig, "agents.defaults.model"),
          resolveConfigValue(runtimeConfig, pathKey),
        ),
      );
    }
    return !jsonEqual(
      resolveConfigValue(baseConfig, pathKey),
      resolveConfigValue(runtimeConfig, pathKey),
    );
  });
  const baseExistingProfiles = collectExistingSessionProfiles(baseConfig);
  const runtimeExistingProfiles = collectExistingSessionProfiles(runtimeConfig);
  const browserSidecarSkipped = String(params.browserSidecarSkipped ?? "").trim() === "1";
  const browserSidecarEnabled =
    resolveConfigValue(runtimeConfig, "browser.enabled") !== false && !browserSidecarSkipped;
  const uploadDir = String(params.uploadDir ?? "/tmp/openclaw/uploads").trim();

  return {
    main_commit: String(params.mainCommit ?? "unknown"),
    tester_commit: String(params.testerCommit ?? "unknown"),
    config_diff_allowed_only: unexpectedDiffs.length === 0,
    config_diff_unexpected_paths: unexpectedDiffs,
    browser_sidecar_enabled: browserSidecarEnabled,
    browser_profiles_match: jsonEqual(baseExistingProfiles, runtimeExistingProfiles),
    browser_existing_session_profiles: runtimeExistingProfiles,
    tools_match: jsonEqual(
      resolveConfigValue(baseConfig, "tools"),
      resolveConfigValue(runtimeConfig, "tools"),
    ),
    plugins_match:
      jsonEqual(
        resolveConfigValue(baseConfig, "plugins.allow"),
        resolveConfigValue(runtimeConfig, "plugins.allow"),
      ) &&
      jsonEqual(
        resolveConfigValue(baseConfig, "plugins.deny"),
        resolveConfigValue(runtimeConfig, "plugins.deny"),
      ) &&
      jsonEqual(
        normalizePluginSlotsForParity(resolveConfigValue(baseConfig, "plugins.slots")),
        normalizePluginSlotsForParity(resolveConfigValue(runtimeConfig, "plugins.slots")),
      ),
    model_config_match:
      jsonEqual(
        resolveConfigValue(baseConfig, "agents.defaults.model"),
        resolveConfigValue(runtimeConfig, "agents.defaults.model"),
      ) &&
      jsonEqual(
        normalizeTesterModelAllowlistForParity(
          resolveConfigValue(baseConfig, "agents.defaults.model"),
          resolveConfigValue(baseConfig, "agents.defaults.models"),
        ),
        normalizeTesterModelAllowlistForParity(
          resolveConfigValue(runtimeConfig, "agents.defaults.model"),
          resolveConfigValue(runtimeConfig, "agents.defaults.models"),
        ),
      ),
    runtime_worktree: String(params.runtimeWorktree ?? "unknown"),
    runtime_port: String(params.runtimePort ?? "unknown"),
    current_lane_bot: String(params.currentLaneBot ?? "unknown"),
    upload_dir: uploadDir,
    upload_dir_ready: Boolean(uploadDir && fs.existsSync(uploadDir)),
    acceptable_config_diffs: [
      "channels.telegram.botToken",
      "channels.telegram.accounts",
      "gateway.port",
      "gateway.auth.token",
      "gateway.controlUi",
      "gateway.reload",
      "agents.defaults.workspace",
      "agents.defaults.heartbeat",
      "agents.defaults.memorySearch.store.path",
      "bindings",
    ],
  };
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

export function resolveTesterRuntimeAuthStoreFromSources(params = {}) {
  const modelProvider =
    resolveModelProvider(params?.preferredModel) || resolveModelProvider(params?.defaultModel);
  const sourceAuthPaths = normalizeStringList(params?.sourceAuthPaths ?? []);
  const checkedPaths = [];

  if (!modelProvider) {
    return {
      ok: false,
      reason: "model_provider_unresolved",
      provider: "",
      sourceAuthPath: "",
      checkedPathCount: 0,
      store: { version: 1, profiles: {} },
    };
  }

  for (const sourceAuthPath of sourceAuthPaths) {
    if (!fs.existsSync(sourceAuthPath)) {
      continue;
    }
    checkedPaths.push(sourceAuthPath);

    let parsedStore;
    try {
      parsedStore = JSON.parse(fs.readFileSync(sourceAuthPath, "utf8"));
    } catch {
      continue;
    }

    const store = pruneTesterRuntimeAuthStore({
      store: parsedStore,
      preferredModel: params?.preferredModel,
      defaultModel: params?.defaultModel,
    });
    const profileIds = Object.keys(store.profiles ?? {});
    if (profileIds.length === 0) {
      continue;
    }

    return {
      ok: true,
      reason: "ok",
      provider: modelProvider,
      sourceAuthPath,
      checkedPathCount: checkedPaths.length,
      profileCount: profileIds.length,
      profileIds,
      store,
    };
  }

  return {
    ok: false,
    reason: checkedPaths.length > 0 ? "no_matching_provider_profile" : "no_source_auth_store",
    provider: modelProvider,
    sourceAuthPath: "",
    checkedPathCount: checkedPaths.length,
    store: { version: 1, profiles: {} },
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
