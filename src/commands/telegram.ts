import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  runTelegramUserPrecheck,
  runTelegramUserRead,
  runTelegramUserSend,
  sleep as telegramUserSleep,
} from "../telegram-user/backend.js";
import type {
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
  TelegramUserWaitResult,
} from "../telegram-user/types.js";
import { runTelegramUserWait } from "../telegram-user/wait.js";

const execFileAsync = promisify(execFile);

type TelegramDoctorCheck = {
  ok: boolean;
  failure_reason: string | null;
  details?: Record<string, unknown>;
};

type TelegramDoctorReport = {
  ok: boolean;
  scenario: "doctor";
  branch: string | null;
  runtime_worktree: string | null;
  runtime_commit: string | null;
  runtime_pid: number | null;
  runtime_port: number | null;
  current_lane_bot: string | null;
  chat: string | null;
  topic_id: number | null;
  sent_message_id: number | null;
  reply_message_id: number | null;
  matched_by: string | null;
  elapsed_ms: number;
  failure_reason: string | null;
  failure_reasons: string[];
  checks: {
    branch: TelegramDoctorCheck;
    tester_bot_claim: TelegramDoctorCheck;
    runtime_worktree: TelegramDoctorCheck;
    gateway: TelegramDoctorCheck;
    userbot_session: TelegramDoctorCheck;
    chat?: TelegramDoctorCheck;
    topic?: TelegramDoctorCheck;
  };
  userbot?: {
    session_path: string | null;
    user_id: number | null;
    username: string | null;
  };
  resolved_chat?: {
    chat_id: number | null;
    username: string | null;
    peer_type: string | null;
  } | null;
};

type TelegramSmokeProof = {
  ok: boolean;
  scenario: "dm-reply" | "baseline" | "reply-contract";
  branch: string | null;
  runtime_worktree: string | null;
  runtime_commit: string | null;
  runtime_pid: number | null;
  runtime_port: number | null;
  current_lane_bot: string | null;
  chat: string | null;
  topic_id: number | null;
  sent_message_id: number | null;
  reply_message_id: number | null;
  matched_by: string | null;
  elapsed_ms: number;
  failure_reason: string | null;
  failure_reasons: string[];
  artifact_path: string | null;
  bot_id?: number | null;
  bot_username?: string | null;
  reply_text?: string | null;
  reply_sender_id?: number | null;
  reply_to_msg_id?: number | null;
  reply_to_top_id?: number | null;
};

type TelegramE2eScenarioName = "tts-final-caption" | "progress-long-task" | "progress-plus-tts";

type TelegramBaselineProof = TelegramSmokeProof & {
  scenario: "baseline";
  baseline: "pass" | "fail";
  featureScenario: "not_run";
  mergeReadiness: "insufficient";
};

type TelegramScenarioProof = {
  ok: boolean;
  scenario: TelegramE2eScenarioName;
  branch: string | null;
  runtime_worktree: string | null;
  runtime_commit: string | null;
  runtime_pid: number | null;
  runtime_port: number | null;
  runtime_health: "pass" | "fail";
  current_lane_bot: string | null;
  chat: string | null;
  topic_id: number | null;
  sent_message_id: number | null;
  progress_message_ids: number[];
  final_message_id: number | null;
  message_ids: number[];
  matched_by: string | null;
  elapsed_ms: number;
  pass_fail_reason: string;
  failure_reason: string | null;
  failure_reasons: string[];
  artifact_path: string | null;
  featureScenario: TelegramE2eScenarioName;
  mergeReadiness: "sufficient" | "insufficient";
  final_visible_text: string | null;
  empty_voice_only_final_detected: boolean;
  final_answer_present_after_cleanup: boolean | null;
  progress_texts: string[];
  deterministic?: boolean;
  final_marker?: string;
  poison_progress_strings?: string[];
  progress_transient_message_id?: number | null;
  audio_message_id?: number | null;
  audio_message_kind?: string | null;
  audio_caption_text?: string | null;
  durable_progress_texts?: string[];
  gateway_proof?: Record<string, unknown> | null;
};

type TelegramSmokeReplyClassification = {
  ok: boolean;
  failureReason: string | null;
};

type TelegramTesterReplyContractStatus = "blocked" | "finished" | "not_observed";

type TelegramTesterReplyContractProof = TelegramSmokeProof & {
  scenario: "reply-contract";
  proof_id: string;
  starting_message_id: number | null;
  final_message_id: number | null;
  final_status: TelegramTesterReplyContractStatus;
  final_fields: Record<string, string>;
  last_step: string | null;
  required_fields: string[];
};

type ParsedTelegramTesterContractMessage =
  | { kind: "blocked"; fields: Record<string, string> }
  | { kind: "finished"; fields: Record<string, string> }
  | { kind: "starting"; fields: Record<string, string> }
  | { kind: "unrelated"; fields: Record<string, string> };

type TelegramRuntimeReport = {
  ok: boolean;
  action: "ensure" | "release";
  branch: string | null;
  runtime_worktree: string | null;
  runtime_commit: string | null;
  runtime_pid: number | null;
  runtime_port: number | null;
  current_lane_bot: string | null;
  failure_reason: string | null;
  failure_reasons: string[];
  proof: Record<string, string | string[]>;
  errors: string[];
};

type TelegramRuntimeOwnership = {
  pid: number | null;
  worktree: string | null;
  command: string | null;
  ownershipOk: boolean;
  failureReason: string | null;
};

type TelegramRepoContext = {
  branch: string | null;
  commit: string | null;
  repoRoot: string;
  worktree: string;
};

type TelegramHelperProfile = {
  profileId: string;
  runtimePort: number;
  runtimeStateDir: string;
  worktreePath: string;
};

type TelegramGatewayAuth = {
  configPath?: string;
  password?: string;
  token?: string;
};

type TelegramBotIdentity = {
  id: number | null;
  username: string | null;
  name: string | null;
};

type TelegramUserRuntimeOptions = {
  envFile: string | null;
  session: string | null;
};

type TelegramScriptCallResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

export const telegramCommandDeps = {
  now: () => Date.now(),
  newRunId: () => randomUUID().slice(0, 8),
  async exec(args: string[], options: { cwd?: string } = {}) {
    return execFileAsync(args[0], args.slice(1), {
      cwd: options.cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
  },
  async fetchJson(url: string, timeoutMs: number) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text,
    };
  },
  async callGateway(
    method: string,
    params: unknown,
    runtimePort: number,
    timeoutMs: number,
    gatewayAuth: TelegramGatewayAuth = {},
  ) {
    return await callGateway({
      url: `ws://127.0.0.1:${runtimePort}`,
      ...(gatewayAuth.configPath ? { configPath: gatewayAuth.configPath } : {}),
      method,
      params,
      ...(gatewayAuth.password ? { password: gatewayAuth.password } : {}),
      timeoutMs,
      ...(gatewayAuth.token ? { token: gatewayAuth.token } : {}),
    });
  },
  async writeFile(filePath: string, content: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  },
  async readFile(filePath: string) {
    return fs.readFile(filePath, "utf8");
  },
  fileExists(filePath: string) {
    return fsSync.existsSync(filePath);
  },
  async readGatewayAuth(runtimeStateDir: string): Promise<TelegramGatewayAuth> {
    const candidates = [
      path.join(runtimeStateDir, "openclaw.telegram-live.json"),
      path.join(runtimeStateDir, "openclaw.json"),
    ];
    const configPath = candidates.find((candidate) => fsSync.existsSync(candidate));
    if (!configPath) {
      return {};
    }
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        gateway?: { auth?: { password?: unknown; token?: unknown } };
      };
      const password =
        typeof parsed.gateway?.auth?.password === "string" &&
        parsed.gateway.auth.password.trim().length > 0
          ? parsed.gateway.auth.password.trim()
          : undefined;
      const token =
        typeof parsed.gateway?.auth?.token === "string" &&
        parsed.gateway.auth.token.trim().length > 0
          ? parsed.gateway.auth.token.trim()
          : undefined;
      // The deterministic scenario deliberately targets a specific live runtime port.
      // A URL override is safe only when the matching runtime auth is also explicit.
      return { configPath, password, token };
    } catch {
      return { configPath };
    }
  },
  async resolveRepoContext(): Promise<TelegramRepoContext> {
    const repoRoot = await resolveTelegramRepoRoot();
    const worktree = await gitOutput(["rev-parse", "--show-toplevel"], repoRoot);
    const branch = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    const commit = await gitOutput(["rev-parse", "HEAD"], repoRoot);
    return {
      branch: branch || null,
      commit: commit || null,
      repoRoot,
      worktree: worktree || repoRoot,
    };
  },
  async resolveHelperProfile(worktreePath: string): Promise<TelegramHelperProfile> {
    const repoRoot = await resolveTelegramRepoRoot();
    const helperPath = path.join(repoRoot, "scripts", "lib", "telegram-live-runtime-helpers.mjs");
    // Reuse the existing runtime-profile derivation so the CLI and bash runtime
    // helpers cannot drift on the worktree->port/state mapping.
    const helpers = (await import(pathToFileURL(helperPath).href)) as {
      deriveTelegramLiveRuntimeProfile: (params: { worktreePath: string }) => TelegramHelperProfile;
    };
    return helpers.deriveTelegramLiveRuntimeProfile({ worktreePath });
  },
  async resolveRuntimeOwnership(
    runtimePort: number,
    worktreePath: string,
  ): Promise<TelegramRuntimeOwnership> {
    const pidOutput = await execCommandAllowFailure([
      "lsof",
      "-nP",
      `-tiTCP:${runtimePort}`,
      "-sTCP:LISTEN",
    ]);
    const pidCandidates = pidOutput.stdout
      .split(/\r?\n/g)
      .map((value) => parsePositiveInt(value))
      .filter((value): value is number => value !== null);

    if (pidCandidates.length === 0) {
      return {
        pid: null,
        worktree: null,
        command: null,
        ownershipOk: false,
        failureReason: "runtime_not_running",
      };
    }
    if (pidCandidates.length > 1) {
      return {
        pid: null,
        worktree: null,
        command: null,
        ownershipOk: false,
        failureReason: "runtime_port_collision",
      };
    }

    const pid = pidCandidates[0];
    const cwdOutput = await execCommandAllowFailure([
      "lsof",
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    const runtimeWorktree = cwdOutput.stdout
      .split(/\r?\n/g)
      .map((line) => (line.startsWith("n") ? line.slice(1).trim() : ""))
      .find(Boolean);
    const cmdOutput = await execCommandAllowFailure(["ps", "-o", "command=", "-p", String(pid)]);
    const command = cmdOutput.stdout.trim() || null;
    const isGatewayProcess = Boolean(
      command && (command.includes(" gateway run") || command.includes("openclaw-gateway")),
    );
    if (!isGatewayProcess) {
      return {
        pid,
        worktree: runtimeWorktree ?? null,
        command,
        ownershipOk: false,
        failureReason: "runtime_listener_not_gateway",
      };
    }
    if (!runtimeWorktree || path.resolve(runtimeWorktree) !== path.resolve(worktreePath)) {
      return {
        pid,
        worktree: runtimeWorktree ?? null,
        command,
        ownershipOk: false,
        failureReason: "runtime_worktree_mismatch",
      };
    }
    return {
      pid,
      worktree: runtimeWorktree,
      command,
      ownershipOk: true,
      failureReason: null,
    };
  },
  async probeGateway(runtimePort: number) {
    try {
      const result = await telegramCommandDeps.fetchJson(
        `http://127.0.0.1:${runtimePort}/readyz`,
        2_500,
      );
      if (!result.ok) {
        return { ok: false, failureReason: `gateway_http_${result.status}` };
      }
      const parsed = JSON.parse(result.body) as { ready?: boolean };
      if (parsed.ready === true) {
        return { ok: true, failureReason: null };
      }
      return { ok: false, failureReason: "gateway_not_ready" };
    } catch {
      return { ok: false, failureReason: "gateway_unreachable" };
    }
  },
  async readTelegramBotToken(repoRoot: string) {
    return readLastEnvValue(path.join(repoRoot, ".env.local"), "TELEGRAM_BOT_TOKEN");
  },
  async resolveTokenClaimPaths(repoRoot: string, token: string) {
    if (!token.trim()) {
      return [] as string[];
    }
    const worktreeList = await gitOutput(["worktree", "list", "--porcelain"], repoRoot);
    const worktrees = worktreeList
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
    const claimPaths: string[] = [];
    for (const worktreePath of worktrees) {
      const claimedToken = await readLastEnvValue(
        path.join(worktreePath, ".env.local"),
        "TELEGRAM_BOT_TOKEN",
      );
      if (claimedToken === token) {
        claimPaths.push(path.resolve(worktreePath));
      }
    }
    return claimPaths;
  },
  async resolveBotIdentity(token: string): Promise<TelegramBotIdentity | null> {
    if (!token.trim()) {
      return null;
    }
    try {
      const result = await telegramCommandDeps.fetchJson(
        `https://api.telegram.org/bot${token}/getMe`,
        10_000,
      );
      if (!result.ok) {
        return null;
      }
      const parsed = JSON.parse(result.body) as {
        result?: { id?: number; username?: string; first_name?: string };
      };
      return {
        id: parsed.result?.id ?? null,
        username: parsed.result?.username ?? null,
        name: parsed.result?.first_name ?? null,
      };
    } catch {
      return null;
    }
  },
  async resolveRuntimeCommit(runtimeWorktree: string | null) {
    if (!runtimeWorktree) {
      return null;
    }
    const commit = await gitOutput(["rev-parse", "HEAD"], runtimeWorktree);
    return commit || null;
  },
  async runRuntimeScript(action: "ensure" | "release"): Promise<TelegramScriptCallResult> {
    const repoRoot = await resolveTelegramRepoRoot();
    const scriptPath = path.join(repoRoot, "scripts", "telegram-live-runtime.sh");
    try {
      const { stdout, stderr } = await execFileAsync("bash", [scriptPath, action], {
        cwd: repoRoot,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const stdout =
        typeof error === "object" && error && "stdout" in error
          ? String((error as { stdout?: string }).stdout ?? "")
          : "";
      const stderr =
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr?: string }).stderr ?? "")
          : "";
      return { ok: false, stdout, stderr };
    }
  },
  runTelegramUserPrecheck,
  runTelegramUserRead,
  runTelegramUserSend,
  runTelegramUserWait,
  sleep: telegramUserSleep,
};

export async function telegramDoctorCommand(
  opts: {
    chat?: string;
    envFile?: string;
    json?: boolean;
    session?: string;
    topicId?: number | string;
  },
  runtime: RuntimeEnv,
) {
  const report = await buildTelegramDoctorReport({
    chat: cleanString(opts.chat),
    envFile: cleanString(opts.envFile),
    session: cleanString(opts.session),
    topicId: parseOptionalPositiveInt(opts.topicId),
  });
  logTelegramPayload(runtime, report, Boolean(opts.json), renderDoctorText);
  if (!report.ok) {
    throw new Error(report.failure_reason ?? "telegram_doctor_failed");
  }
}

export async function telegramRuntimeEnsureCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const report = await buildTelegramRuntimeReport("ensure");
  logTelegramPayload(runtime, report, Boolean(opts.json), renderRuntimeText);
  if (!report.ok) {
    throw new Error(report.failure_reason ?? "telegram_runtime_ensure_failed");
  }
}

export async function telegramRuntimeReleaseCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const report = await buildTelegramRuntimeReport("release");
  logTelegramPayload(runtime, report, Boolean(opts.json), renderRuntimeText);
  if (!report.ok) {
    throw new Error(report.failure_reason ?? "telegram_runtime_release_failed");
  }
}

export async function telegramSmokeDmReplyCommand(
  opts: {
    chat?: string;
    envFile?: string;
    json?: boolean;
    message?: string;
    session?: string;
    text?: string;
    timeout?: number | string;
    topicId?: number | string;
  },
  runtime: RuntimeEnv,
) {
  const chat = cleanString(opts.chat);
  if (!chat) {
    throw new Error("Telegram smoke dm-reply requires --chat.");
  }
  const timeoutSeconds = parseOptionalPositiveInt(opts.timeout) ?? 120;
  const topicId = parseOptionalPositiveInt(opts.topicId);
  const startedAt = telegramCommandDeps.now();
  const repoContext = await telegramCommandDeps.resolveRepoContext();
  const userRuntime = resolveTelegramUserRuntimeOptions(repoContext.repoRoot, {
    envFile: cleanString(opts.envFile),
    session: cleanString(opts.session),
  });
  const scenario = "dm-reply" as const;
  const message =
    cleanString(opts.message) ??
    cleanString(opts.text) ??
    `openclaw-telegram-smoke ${startedAt} who are you and what should I call you?`;

  let artifactPath: string | null = null;
  let proof: TelegramSmokeProof = {
    ok: false,
    scenario,
    branch: repoContext.branch,
    runtime_worktree: repoContext.worktree,
    runtime_commit: repoContext.commit,
    runtime_pid: null,
    runtime_port: null,
    current_lane_bot: null,
    chat,
    topic_id: topicId,
    sent_message_id: null,
    reply_message_id: null,
    matched_by: null,
    elapsed_ms: 0,
    failure_reason: null,
    failure_reasons: [],
    artifact_path: null,
  };

  try {
    const doctor = await buildTelegramDoctorReport({
      chat,
      envFile: userRuntime.envFile,
      session: userRuntime.session,
      topicId,
    });
    proof = {
      ...proof,
      branch: doctor.branch,
      runtime_worktree: doctor.runtime_worktree,
      runtime_commit: doctor.runtime_commit,
      runtime_pid: doctor.runtime_pid,
      runtime_port: doctor.runtime_port,
      current_lane_bot: doctor.current_lane_bot,
      failure_reason: doctor.failure_reason,
      failure_reasons: doctor.failure_reasons,
    };
    if (!doctor.ok || !doctor.resolved_chat) {
      throw new Error(doctor.failure_reason ?? "telegram_doctor_failed");
    }

    const sendResult = await telegramCommandDeps.runTelegramUserSend({
      chat,
      envFile: userRuntime.envFile ?? undefined,
      message,
      session: userRuntime.session ?? undefined,
    });
    const waitResult = await telegramCommandDeps.runTelegramUserWait({
      chat,
      afterId: sendResult.message.message_id,
      contains: "",
      envFile: userRuntime.envFile ?? undefined,
      senderId: doctor.resolved_chat.chat_id ?? 0,
      session: userRuntime.session ?? undefined,
      threadAnchor: topicId ?? undefined,
      timeoutMs: timeoutSeconds * 1000,
    });

    proof = buildTelegramSmokeProof({
      branch: doctor.branch,
      chat,
      currentLaneBot: doctor.current_lane_bot,
      doctor,
      elapsedMs: telegramCommandDeps.now() - startedAt,
      runtimeCommit: doctor.runtime_commit,
      runtimePid: doctor.runtime_pid,
      runtimePort: doctor.runtime_port,
      runtimeWorktree: doctor.runtime_worktree,
      sendResult,
      waitResult,
    });
  } catch (error) {
    proof = {
      ...proof,
      elapsed_ms: telegramCommandDeps.now() - startedAt,
      failure_reason: cleanFailureReason(error),
      failure_reasons: [cleanFailureReason(error)],
    };
  } finally {
    artifactPath = await writeTelegramSmokeArtifact(repoContext.repoRoot, proof);
    proof = {
      ...proof,
      artifact_path: artifactPath,
    };
  }

  logTelegramPayload(runtime, proof, Boolean(opts.json), renderSmokeText);
  if (!proof.ok) {
    throw new Error(proof.failure_reason ?? "telegram_smoke_dm_reply_failed");
  }
}

export async function telegramSmokeBaselineCommand(
  opts: {
    chat?: string;
    envFile?: string;
    json?: boolean;
    message?: string;
    session?: string;
    text?: string;
    timeout?: number | string;
    topicId?: number | string;
  },
  runtime: RuntimeEnv,
) {
  const proof = await runTelegramBaselineSmoke(opts);
  logTelegramPayload(runtime, proof, Boolean(opts.json), renderBaselineText);
  if (!proof.ok) {
    throw new Error(proof.failure_reason ?? "telegram_smoke_baseline_failed");
  }
}

export async function telegramSmokeReplyContractCommand(
  opts: {
    chat?: string;
    envFile?: string;
    json?: boolean;
    message?: string;
    proofId?: string;
    session?: string;
    text?: string;
    timeout?: number | string;
    topicId?: number | string;
  },
  runtime: RuntimeEnv,
) {
  const proof = await runTelegramTesterReplyContractSmoke(opts);
  logTelegramPayload(runtime, proof, Boolean(opts.json), renderTesterReplyContractText);
  if (!proof.ok) {
    throw new Error(proof.failure_reason ?? "telegram_smoke_reply_contract_failed");
  }
}

export async function telegramScenarioTtsFinalCaptionCommand(
  opts: TelegramScenarioCommandOptions,
  runtime: RuntimeEnv,
) {
  await runTelegramScenarioCommand("tts-final-caption", opts, runtime);
}

export async function telegramScenarioProgressLongTaskCommand(
  opts: TelegramScenarioCommandOptions,
  runtime: RuntimeEnv,
) {
  await runTelegramScenarioCommand("progress-long-task", opts, runtime);
}

export async function telegramScenarioProgressPlusTtsCommand(
  opts: TelegramScenarioCommandOptions,
  runtime: RuntimeEnv,
) {
  await runTelegramScenarioCommand("progress-plus-tts", opts, runtime);
}

type TelegramScenarioCommandOptions = {
  chat?: string;
  deterministic?: boolean;
  envFile?: string;
  json?: boolean;
  message?: string;
  session?: string;
  text?: string;
  timeout?: number | string;
  topicId?: number | string;
};

async function runTelegramScenarioCommand(
  scenario: TelegramE2eScenarioName,
  opts: TelegramScenarioCommandOptions,
  runtime: RuntimeEnv,
) {
  const proof = await runTelegramFeatureScenario(scenario, opts);
  logTelegramPayload(runtime, proof, Boolean(opts.json), renderScenarioText);
  if (!proof.ok) {
    throw new Error(proof.failure_reason ?? `telegram_scenario_${scenario}_failed`);
  }
}

export function parseTelegramScriptOutput(text: string): {
  fields: Record<string, string | string[]>;
  errors: string[];
} {
  // Keep the bash runtime scripts as the stateful engine for now, but parse
  // their proof lines here so higher-level JSON and artifacts come from one
  // TypeScript implementation.
  const accumulator = new Map<string, string[]>();
  const errors: string[] = [];
  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (key === "error") {
      errors.push(value);
      continue;
    }
    const bucket = accumulator.get(key) ?? [];
    bucket.push(value);
    accumulator.set(key, bucket);
  }

  const fields: Record<string, string | string[]> = {};
  for (const [key, values] of accumulator.entries()) {
    fields[key] = values.length === 1 ? values[0] : values;
  }
  return { fields, errors };
}

export function buildTelegramSmokeArtifactPath(
  repoRoot: string,
  scenario: string,
  runId: string,
  at: Date,
) {
  const timestamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    repoRoot,
    ".artifacts",
    "telegram-smoke",
    `${timestamp}-${scenario}-${runId}.json`,
  );
}

function resolveTelegramUserRuntimeOptions(
  repoRoot: string,
  params: TelegramUserRuntimeOptions,
): TelegramUserRuntimeOptions {
  const envFile = cleanString(params.envFile);
  const session = cleanString(params.session);
  const defaultEnvFile = path.join(repoRoot, "scripts", "telegram-e2e", ".env.local");
  const defaultSession = path.join(repoRoot, "scripts", "telegram-e2e", "tmp", "userbot.session");

  return {
    envFile: envFile ?? (telegramCommandDeps.fileExists(defaultEnvFile) ? defaultEnvFile : null),
    session: session ?? (telegramCommandDeps.fileExists(defaultSession) ? defaultSession : null),
  };
}

async function buildTelegramDoctorReport(params: {
  chat: string | null;
  envFile: string | null;
  session: string | null;
  topicId: number | null;
}): Promise<TelegramDoctorReport> {
  const startedAt = telegramCommandDeps.now();
  const repo = await telegramCommandDeps.resolveRepoContext();
  const profile = await telegramCommandDeps.resolveHelperProfile(repo.worktree);
  const token = await telegramCommandDeps.readTelegramBotToken(repo.repoRoot);
  const tokenClaimPaths = token
    ? await telegramCommandDeps.resolveTokenClaimPaths(repo.repoRoot, token)
    : [];
  const botIdentity = token ? await telegramCommandDeps.resolveBotIdentity(token) : null;
  const runtimeOwnership = await telegramCommandDeps.resolveRuntimeOwnership(
    profile.runtimePort,
    repo.worktree,
  );
  const gateway = await telegramCommandDeps.probeGateway(profile.runtimePort);
  const runtimeCommit = await telegramCommandDeps.resolveRuntimeCommit(runtimeOwnership.worktree);
  const userRuntime = resolveTelegramUserRuntimeOptions(repo.repoRoot, {
    envFile: params.envFile,
    session: params.session,
  });

  let userbotPrecheck: TelegramUserPrecheck | null = null;
  let userbotFailureReason: string | null = null;
  try {
    userbotPrecheck = await telegramCommandDeps.runTelegramUserPrecheck({
      ...(userRuntime.envFile ? { envFile: userRuntime.envFile } : {}),
      ...(userRuntime.session ? { session: userRuntime.session } : {}),
    });
  } catch (error) {
    userbotFailureReason = cleanFailureReason(error);
  }

  let chatPrecheck: TelegramUserPrecheck | null = null;
  let chatFailureReason: string | null = null;
  if (params.chat) {
    try {
      chatPrecheck = await telegramCommandDeps.runTelegramUserPrecheck({
        chat: params.chat,
        ...(userRuntime.envFile ? { envFile: userRuntime.envFile } : {}),
        ...(userRuntime.session ? { session: userRuntime.session } : {}),
      });
    } catch (error) {
      chatFailureReason = cleanFailureReason(error);
    }
  }

  const checks: TelegramDoctorReport["checks"] = {
    branch: {
      ok: Boolean(repo.branch && repo.branch !== "HEAD"),
      failure_reason: repo.branch && repo.branch !== "HEAD" ? null : "branch_detached_head",
      details: { branch: repo.branch },
    },
    tester_bot_claim: buildTokenClaimCheck(repo.worktree, token, tokenClaimPaths, botIdentity),
    runtime_worktree: {
      ok: runtimeOwnership.ownershipOk,
      failure_reason: runtimeOwnership.failureReason,
      details: {
        runtime_pid: runtimeOwnership.pid,
        runtime_worktree: runtimeOwnership.worktree,
      },
    },
    gateway: {
      ok: gateway.ok,
      failure_reason: gateway.failureReason,
      details: { runtime_port: profile.runtimePort },
    },
    userbot_session: {
      ok: Boolean(userbotPrecheck),
      failure_reason: userbotFailureReason ?? null,
      details: {
        session_path:
          userbotPrecheck?.session_path ?? defaultTelegramUserSessionPath(repo.repoRoot),
        user_id: userbotPrecheck?.user.user_id ?? null,
        username: userbotPrecheck?.user.username ?? null,
      },
    },
  };

  if (params.chat) {
    checks.chat = {
      ok: Boolean(chatPrecheck?.chat),
      failure_reason: chatFailureReason ?? (chatPrecheck?.chat ? null : "chat_invalid"),
      details: {
        chat: params.chat,
        chat_id: chatPrecheck?.chat?.chat_id ?? null,
        username: chatPrecheck?.chat?.username ?? null,
      },
    };
  }
  if (params.topicId !== null || params.chat) {
    checks.topic = buildTopicCheck(params.chat, params.topicId);
  }

  const failureReason = firstTelegramFailureReason([
    checks.branch,
    checks.tester_bot_claim,
    checks.runtime_worktree,
    checks.gateway,
    checks.userbot_session,
    checks.chat,
    checks.topic,
  ]);

  return {
    ok: failureReason === null,
    scenario: "doctor",
    branch: repo.branch,
    runtime_worktree: runtimeOwnership.worktree,
    runtime_commit: runtimeCommit,
    runtime_pid: runtimeOwnership.pid,
    runtime_port: profile.runtimePort,
    current_lane_bot: formatCurrentLaneBot(botIdentity, token),
    chat: params.chat,
    topic_id: params.topicId,
    sent_message_id: null,
    reply_message_id: null,
    matched_by: null,
    elapsed_ms: telegramCommandDeps.now() - startedAt,
    failure_reason: failureReason,
    failure_reasons: checksToFailureReasons([
      checks.branch,
      checks.tester_bot_claim,
      checks.runtime_worktree,
      checks.gateway,
      checks.userbot_session,
      checks.chat,
      checks.topic,
    ]),
    checks,
    userbot: {
      session_path: userbotPrecheck?.session_path ?? defaultTelegramUserSessionPath(repo.repoRoot),
      user_id: userbotPrecheck?.user.user_id ?? null,
      username: userbotPrecheck?.user.username ?? null,
    },
    resolved_chat: chatPrecheck?.chat
      ? {
          chat_id: chatPrecheck.chat.chat_id,
          username: chatPrecheck.chat.username,
          peer_type: chatPrecheck.chat.peer_type,
        }
      : null,
  };
}

async function buildTelegramRuntimeReport(
  action: "ensure" | "release",
): Promise<TelegramRuntimeReport> {
  const scriptResult = await telegramCommandDeps.runRuntimeScript(action);
  const parsed = parseTelegramScriptOutput(`${scriptResult.stdout}\n${scriptResult.stderr}`);
  const runtimeWorktree = getLastField(parsed.fields, ["runtime_worktree", "release_worktree"]);
  const runtimeCommit = await telegramCommandDeps.resolveRuntimeCommit(runtimeWorktree);
  return {
    ok: scriptResult.ok,
    action,
    branch: getLastField(parsed.fields, ["branch"]),
    runtime_worktree: runtimeWorktree,
    runtime_commit: runtimeCommit,
    runtime_pid: parseOptionalPositiveInt(
      getLastField(parsed.fields, ["runtime_pid", "release_runtime_pid"]),
    ),
    runtime_port: parseOptionalPositiveInt(
      getLastField(parsed.fields, ["runtime_port", "release_runtime_port"]),
    ),
    current_lane_bot: getLastField(parsed.fields, ["current_lane_bot"]),
    failure_reason: parsed.errors[0] ?? null,
    failure_reasons: parsed.errors,
    proof: parsed.fields,
    errors: parsed.errors,
  };
}

function buildTelegramSmokeProof(params: {
  branch: string | null;
  chat: string;
  currentLaneBot: string | null;
  doctor: TelegramDoctorReport;
  elapsedMs: number;
  runtimeCommit: string | null;
  runtimePid: number | null;
  runtimePort: number | null;
  runtimeWorktree: string | null;
  sendResult: TelegramUserSendResult;
  waitResult: TelegramUserWaitResult;
}): TelegramSmokeProof {
  const topicId =
    params.waitResult.matched.direct_messages_topic?.topic_id ??
    params.waitResult.matched.direct_messages_topic_id ??
    params.doctor.topic_id;
  const replyClassification = classifyTelegramSmokeReply(params.waitResult.matched.text);
  return {
    ok: replyClassification.ok,
    scenario: "dm-reply",
    branch: params.branch,
    runtime_worktree: params.runtimeWorktree,
    runtime_commit: params.runtimeCommit,
    runtime_pid: params.runtimePid,
    runtime_port: params.runtimePort,
    current_lane_bot: params.currentLaneBot,
    chat: params.chat,
    topic_id: topicId ?? null,
    sent_message_id: params.sendResult.message.message_id,
    reply_message_id: params.waitResult.matched.message_id,
    matched_by: params.waitResult.matched_by,
    elapsed_ms: params.elapsedMs,
    failure_reason: replyClassification.failureReason,
    failure_reasons: replyClassification.failureReason ? [replyClassification.failureReason] : [],
    artifact_path: null,
    bot_id: params.doctor.resolved_chat?.chat_id ?? null,
    bot_username: params.doctor.resolved_chat?.username ?? null,
    reply_text: params.waitResult.matched.text,
    reply_sender_id: params.waitResult.matched.sender_id,
    reply_to_msg_id: params.waitResult.matched.reply_to_msg_id,
    reply_to_top_id: params.waitResult.matched.reply_to_top_id,
  };
}

async function runTelegramBaselineSmoke(opts: {
  chat?: string;
  envFile?: string;
  message?: string;
  session?: string;
  text?: string;
  timeout?: number | string;
  topicId?: number | string;
}): Promise<TelegramBaselineProof> {
  const runtimeReport = await buildTelegramRuntimeReport("ensure");
  const chat = cleanString(opts.chat) ?? runtimeReport.current_lane_bot;
  const proof = await runDmReplySmoke({
    chat,
    envFile: cleanString(opts.envFile),
    message:
      cleanString(opts.message) ??
      cleanString(opts.text) ??
      `openclaw-telegram-baseline ${telegramCommandDeps.now()} reply with one short sentence`,
    scenario: "baseline",
    session: cleanString(opts.session),
    timeoutSeconds: parseOptionalPositiveInt(opts.timeout) ?? 120,
    topicId: parseOptionalPositiveInt(opts.topicId),
  });

  const failureReasons = [...runtimeReport.failure_reasons, ...proof.failure_reasons].filter(
    Boolean,
  );
  const ok = runtimeReport.ok && proof.ok;
  const failureReason =
    runtimeReport.failure_reason ?? proof.failure_reason ?? (ok ? null : "baseline_failed");

  return {
    ...proof,
    ok,
    scenario: "baseline",
    baseline: ok ? "pass" : "fail",
    featureScenario: "not_run",
    mergeReadiness: "insufficient",
    runtime_commit: proof.runtime_commit ?? runtimeReport.runtime_commit,
    runtime_pid: proof.runtime_pid ?? runtimeReport.runtime_pid,
    runtime_port: proof.runtime_port ?? runtimeReport.runtime_port,
    current_lane_bot: proof.current_lane_bot ?? runtimeReport.current_lane_bot,
    failure_reason: failureReason,
    failure_reasons: failureReasons.length > 0 ? failureReasons : proof.failure_reasons,
  };
}

async function runDmReplySmoke(params: {
  chat: string | null;
  envFile: string | null;
  message: string;
  scenario: "dm-reply" | "baseline";
  session: string | null;
  timeoutSeconds: number;
  topicId: number | null;
}): Promise<TelegramSmokeProof> {
  if (!params.chat) {
    throw new Error("claimed_tester_bot_unresolved");
  }

  const startedAt = telegramCommandDeps.now();
  const repoContext = await telegramCommandDeps.resolveRepoContext();
  const userRuntime = resolveTelegramUserRuntimeOptions(repoContext.repoRoot, {
    envFile: params.envFile,
    session: params.session,
  });
  let proof: TelegramSmokeProof = {
    ok: false,
    scenario: "dm-reply",
    branch: repoContext.branch,
    runtime_worktree: repoContext.worktree,
    runtime_commit: repoContext.commit,
    runtime_pid: null,
    runtime_port: null,
    current_lane_bot: null,
    chat: params.chat,
    topic_id: params.topicId,
    sent_message_id: null,
    reply_message_id: null,
    matched_by: null,
    elapsed_ms: 0,
    failure_reason: null,
    failure_reasons: [],
    artifact_path: null,
  };

  try {
    const doctor = await buildTelegramDoctorReport({
      chat: params.chat,
      envFile: userRuntime.envFile,
      session: userRuntime.session,
      topicId: params.topicId,
    });
    proof = {
      ...proof,
      branch: doctor.branch,
      runtime_worktree: doctor.runtime_worktree,
      runtime_commit: doctor.runtime_commit,
      runtime_pid: doctor.runtime_pid,
      runtime_port: doctor.runtime_port,
      current_lane_bot: doctor.current_lane_bot,
      failure_reason: doctor.failure_reason,
      failure_reasons: doctor.failure_reasons,
    };
    if (!doctor.ok || !doctor.resolved_chat) {
      throw new Error(doctor.failure_reason ?? "telegram_doctor_failed");
    }

    const sendResult = await telegramCommandDeps.runTelegramUserSend({
      chat: params.chat,
      envFile: userRuntime.envFile ?? undefined,
      message: params.message,
      session: userRuntime.session ?? undefined,
    });
    const waitResult = await telegramCommandDeps.runTelegramUserWait({
      chat: params.chat,
      afterId: sendResult.message.message_id,
      contains: "",
      envFile: userRuntime.envFile ?? undefined,
      senderId: doctor.resolved_chat.chat_id ?? 0,
      session: userRuntime.session ?? undefined,
      threadAnchor: params.topicId ?? undefined,
      timeoutMs: params.timeoutSeconds * 1000,
    });

    proof = buildTelegramSmokeProof({
      branch: doctor.branch,
      chat: params.chat,
      currentLaneBot: doctor.current_lane_bot,
      doctor,
      elapsedMs: telegramCommandDeps.now() - startedAt,
      runtimeCommit: doctor.runtime_commit,
      runtimePid: doctor.runtime_pid,
      runtimePort: doctor.runtime_port,
      runtimeWorktree: doctor.runtime_worktree,
      sendResult,
      waitResult,
    });
  } catch (error) {
    proof = {
      ...proof,
      elapsed_ms: telegramCommandDeps.now() - startedAt,
      failure_reason: cleanFailureReason(error),
      failure_reasons: [cleanFailureReason(error)],
    };
  } finally {
    const artifactPath = await writeTelegramSmokeArtifact(repoContext.repoRoot, {
      ...proof,
      scenario: params.scenario,
    });
    proof = {
      ...proof,
      artifact_path: artifactPath,
    };
  }

  return proof;
}

async function runTelegramTesterReplyContractSmoke(opts: {
  chat?: string;
  envFile?: string;
  message?: string;
  proofId?: string;
  session?: string;
  text?: string;
  timeout?: number | string;
  topicId?: number | string;
}): Promise<TelegramTesterReplyContractProof> {
  const runtimeReport = await buildTelegramRuntimeReport("ensure");
  const chat = cleanString(opts.chat) ?? runtimeReport.current_lane_bot;
  if (!chat) {
    throw new Error("claimed_tester_bot_unresolved");
  }

  const startedAt = telegramCommandDeps.now();
  const repoContext = await telegramCommandDeps.resolveRepoContext();
  const userRuntime = resolveTelegramUserRuntimeOptions(repoContext.repoRoot, {
    envFile: cleanString(opts.envFile),
    session: cleanString(opts.session),
  });
  const topicId = parseOptionalPositiveInt(opts.topicId);
  const timeoutMs = (parseOptionalPositiveInt(opts.timeout) ?? 120) * 1000;
  const proofId =
    cleanString(opts.proofId) ?? `tester-reply-contract-${telegramCommandDeps.newRunId()}`;
  const requiredFields = [
    "branch",
    "runtime_worktree",
    "runtime_commit",
    "current_lane_bot",
    "errors",
  ];

  let proof = buildInitialTesterReplyContractProof({
    chat,
    proofId,
    repoContext,
    requiredFields,
    runtimeReport,
    topicId,
  });

  try {
    if (!runtimeReport.ok) {
      throw new Error(runtimeReport.failure_reason ?? "telegram_runtime_ensure_failed");
    }

    const doctor = await buildTelegramDoctorReport({
      chat,
      envFile: userRuntime.envFile,
      session: userRuntime.session,
      topicId,
    });
    proof = {
      ...proof,
      branch: doctor.branch,
      runtime_worktree: doctor.runtime_worktree,
      runtime_commit: doctor.runtime_commit,
      runtime_pid: doctor.runtime_pid,
      runtime_port: doctor.runtime_port,
      current_lane_bot: doctor.current_lane_bot,
      failure_reason: doctor.failure_reason,
      failure_reasons: doctor.failure_reasons,
    };
    if (!doctor.ok || !doctor.resolved_chat) {
      throw new Error(doctor.failure_reason ?? "telegram_doctor_failed");
    }

    const requestedMessage = cleanString(opts.message) ?? cleanString(opts.text);
    const message =
      requestedMessage ??
      buildTesterReplyContractPrompt({
        currentLaneBot: doctor.current_lane_bot,
        proofId,
        repoContext,
        requiredFields,
      });
    const sendResult = await telegramCommandDeps.runTelegramUserSend({
      chat,
      envFile: userRuntime.envFile ?? undefined,
      message,
      session: userRuntime.session ?? undefined,
    });

    proof = {
      ...proof,
      sent_message_id: sendResult.message.message_id,
    };

    const contractResult = await waitForTesterReplyContract({
      afterId: sendResult.message.message_id,
      botId: doctor.resolved_chat.chat_id ?? 0,
      chat,
      envFile: userRuntime.envFile,
      proofId,
      requiredFields,
      session: userRuntime.session,
      startedAt,
      timeoutMs,
      topicId,
    });

    proof = {
      ...proof,
      ok: contractResult.ok,
      elapsed_ms: telegramCommandDeps.now() - startedAt,
      failure_reason: contractResult.failureReason,
      failure_reasons: contractResult.failureReason ? [contractResult.failureReason] : [],
      final_fields: contractResult.finalFields,
      final_message_id: contractResult.finalMessageId,
      final_status: contractResult.finalStatus,
      last_step: contractResult.lastStep,
      matched_by: contractResult.matchedBy,
      reply_message_id: contractResult.finalMessageId,
      reply_text: contractResult.replyText,
      starting_message_id: contractResult.startingMessageId,
    };
  } catch (error) {
    const reason = cleanFailureReason(error);
    proof = {
      ...proof,
      elapsed_ms: telegramCommandDeps.now() - startedAt,
      failure_reason: reason,
      failure_reasons: [...new Set([...proof.failure_reasons, reason])],
      last_step: proof.last_step ?? "setup_or_send",
    };
  } finally {
    const artifactPath = await writeTelegramSmokeArtifact(repoContext.repoRoot, proof);
    proof = {
      ...proof,
      artifact_path: artifactPath,
    };
  }

  return proof;
}

function buildInitialTesterReplyContractProof(params: {
  chat: string;
  proofId: string;
  repoContext: TelegramRepoContext;
  requiredFields: string[];
  runtimeReport: TelegramRuntimeReport;
  topicId: number | null;
}): TelegramTesterReplyContractProof {
  return {
    ok: false,
    scenario: "reply-contract",
    branch: params.runtimeReport.branch ?? params.repoContext.branch,
    runtime_worktree: params.runtimeReport.runtime_worktree ?? params.repoContext.worktree,
    runtime_commit: params.runtimeReport.runtime_commit ?? params.repoContext.commit,
    runtime_pid: params.runtimeReport.runtime_pid,
    runtime_port: params.runtimeReport.runtime_port,
    current_lane_bot: params.runtimeReport.current_lane_bot,
    chat: params.chat,
    topic_id: params.topicId,
    sent_message_id: null,
    reply_message_id: null,
    matched_by: null,
    elapsed_ms: 0,
    failure_reason: params.runtimeReport.failure_reason,
    failure_reasons: [...params.runtimeReport.failure_reasons],
    artifact_path: null,
    proof_id: params.proofId,
    starting_message_id: null,
    final_message_id: null,
    final_status: "not_observed",
    final_fields: {},
    last_step: "runtime_ensure",
    required_fields: params.requiredFields,
  };
}

function buildTesterReplyContractPrompt(params: {
  currentLaneBot: string | null;
  proofId: string;
  repoContext: TelegramRepoContext;
  requiredFields: string[];
}) {
  const requiredFieldLines = params.requiredFields.map((field) => `${field}=<value>`).join("\n");
  // Keep this task deliberately harmless. It proves deterministic reporting,
  // not lock/unlock, gateway restart, or production bot behavior.
  return [
    `Tester reply-contract smoke proof_id=${params.proofId}.`,
    `Reply immediately with exactly: STARTING ${params.proofId}`,
    "Then run only harmless local checks: pwd, git rev-parse --abbrev-ref HEAD, and git rev-parse HEAD.",
    "Do not run lock/unlock flows. Do not restart, bootout, bootstrap, or mutate any live gateway. Do not touch production/default bots or tokens.",
    "On success, send one final text reply in this exact shape:",
    `FINISHED ${params.proofId}`,
    requiredFieldLines,
    "Set errors=none on success.",
    "If anything blocks you, send one final text reply in this exact shape:",
    `BLOCKED ${params.proofId} reason=<short_snake_case> last_step=<short_snake_case>`,
    "Blank final replies are failure. JSON is not required; use key=value lines.",
    `Expected branch=${params.repoContext.branch ?? "unknown"} runtime_worktree=${params.repoContext.worktree} current_lane_bot=${params.currentLaneBot ?? "unknown"}.`,
  ].join("\n");
}

async function waitForTesterReplyContract(params: {
  afterId: number;
  botId: number;
  chat: string;
  envFile: string | null;
  proofId: string;
  requiredFields: string[];
  session: string | null;
  startedAt: number;
  timeoutMs: number;
  topicId: number | null;
}): Promise<{
  ok: boolean;
  failureReason: string | null;
  finalFields: Record<string, string>;
  finalMessageId: number | null;
  finalStatus: TelegramTesterReplyContractStatus;
  lastStep: string;
  matchedBy: TelegramSmokeProof["matched_by"];
  replyText: string | null;
  startingMessageId: number | null;
}> {
  let startingMessageId: number | null = null;
  let lastStep = "waiting_for_starting";
  const seenMessageIds = new Set<number>();
  const deadline = params.startedAt + params.timeoutMs;

  while (telegramCommandDeps.now() < deadline) {
    const readResult = await telegramCommandDeps.runTelegramUserRead({
      afterId: params.afterId,
      chat: params.chat,
      envFile: params.envFile ?? undefined,
      limit: 80,
      session: params.session ?? undefined,
    });
    const botMessages = readResult.messages
      .filter((message) => message.message_id > params.afterId)
      .filter((message) => (message.sender_id ?? 0) === params.botId)
      .filter((message) => matchesOptionalTelegramTopic(message, params.topicId))
      .toSorted((a, b) => a.message_id - b.message_id);

    for (const message of botMessages) {
      if (seenMessageIds.has(message.message_id)) {
        continue;
      }
      seenMessageIds.add(message.message_id);

      const text = cleanString(message.text);
      if (!text) {
        return {
          ok: false,
          failureReason: startingMessageId ? "blank_final_reply" : "blank_contract_reply",
          finalFields: {},
          finalMessageId: message.message_id,
          finalStatus: "not_observed",
          lastStep,
          matchedBy: "no_thread_filter",
          replyText: message.text,
          startingMessageId,
        };
      }

      const parsed = parseTesterContractMessage(text, params.proofId);
      if (!startingMessageId) {
        if (parsed.kind === "starting") {
          startingMessageId = message.message_id;
          lastStep = "waiting_for_final";
          continue;
        }
        if (parsed.kind === "blocked") {
          return buildBlockedTesterContractResult({
            fields: parsed.fields,
            lastStep: "blocked_before_starting",
            message,
            startingMessageId,
          });
        }
        if (parsed.kind === "finished") {
          return {
            ok: false,
            failureReason: "finished_before_starting",
            finalFields: parsed.fields,
            finalMessageId: message.message_id,
            finalStatus: "finished",
            lastStep: "waiting_for_starting",
            matchedBy: "no_thread_filter",
            replyText: text,
            startingMessageId,
          };
        }
        continue;
      }

      if (parsed.kind === "finished") {
        const missingFields = params.requiredFields.filter((field) => !parsed.fields[field]);
        const errors = parsed.fields.errors;
        const failureReason =
          missingFields.length > 0
            ? `missing_final_fields:${missingFields.join(",")}`
            : errors && errors !== "none"
              ? "tester_reported_errors"
              : null;
        return {
          ok: failureReason === null,
          failureReason,
          finalFields: parsed.fields,
          finalMessageId: message.message_id,
          finalStatus: "finished",
          lastStep: "finished",
          matchedBy: "no_thread_filter",
          replyText: text,
          startingMessageId,
        };
      }

      if (parsed.kind === "blocked") {
        return buildBlockedTesterContractResult({
          fields: parsed.fields,
          lastStep,
          message,
          startingMessageId,
        });
      }
    }

    await telegramCommandDeps.sleep(1_000);
  }

  return {
    ok: false,
    failureReason: startingMessageId ? "final_reply_timeout" : "starting_reply_timeout",
    finalFields: {},
    finalMessageId: null,
    finalStatus: "not_observed",
    lastStep,
    matchedBy: null,
    replyText: null,
    startingMessageId,
  };
}

function buildBlockedTesterContractResult(params: {
  fields: Record<string, string>;
  lastStep: string;
  message: TelegramUserWaitResult["matched"];
  startingMessageId: number | null;
}) {
  const hasReason = Boolean(params.fields.reason);
  const hasLastStep = Boolean(params.fields.last_step);
  return {
    ok: false,
    failureReason: hasReason && hasLastStep ? "tester_blocked" : "blocked_reply_missing_fields",
    finalFields: params.fields,
    finalMessageId: params.message.message_id,
    finalStatus: "blocked" as const,
    lastStep: params.fields.last_step ?? params.lastStep,
    matchedBy: "no_thread_filter" as const,
    replyText: params.message.text,
    startingMessageId: params.startingMessageId,
  };
}

async function runTelegramFeatureScenario(
  scenario: TelegramE2eScenarioName,
  opts: TelegramScenarioCommandOptions,
): Promise<TelegramScenarioProof> {
  const startedAt = telegramCommandDeps.now();
  const runtimeReport = await buildTelegramRuntimeReport("ensure");
  const chat = cleanString(opts.chat) ?? runtimeReport.current_lane_bot;
  const timeoutSeconds = parseOptionalPositiveInt(opts.timeout) ?? 180;
  const topicId = parseOptionalPositiveInt(opts.topicId);
  const envFile = cleanString(opts.envFile);
  const session = cleanString(opts.session);
  const requestedMessage = cleanString(opts.message) ?? cleanString(opts.text);
  const repoContext = await telegramCommandDeps.resolveRepoContext();
  let ttsEnableResult: Awaited<ReturnType<typeof sendAndWaitForAnyReply>> | null = null;

  let proof: TelegramScenarioProof = {
    ok: false,
    scenario,
    branch: runtimeReport.branch ?? repoContext.branch,
    runtime_worktree: runtimeReport.runtime_worktree ?? repoContext.worktree,
    runtime_commit: runtimeReport.runtime_commit ?? repoContext.commit,
    runtime_pid: runtimeReport.runtime_pid,
    runtime_port: runtimeReport.runtime_port,
    runtime_health: runtimeReport.ok ? "pass" : "fail",
    current_lane_bot: runtimeReport.current_lane_bot,
    chat,
    topic_id: topicId,
    sent_message_id: null,
    progress_message_ids: [],
    final_message_id: null,
    message_ids: [],
    matched_by: null,
    elapsed_ms: 0,
    pass_fail_reason: runtimeReport.failure_reason ?? "not_run",
    failure_reason: runtimeReport.failure_reason,
    failure_reasons: [...runtimeReport.failure_reasons],
    artifact_path: null,
    featureScenario: scenario,
    mergeReadiness: "insufficient",
    final_visible_text: null,
    empty_voice_only_final_detected: false,
    final_answer_present_after_cleanup: null,
    progress_texts: [],
  };

  try {
    if (!runtimeReport.ok) {
      throw new Error(runtimeReport.failure_reason ?? "telegram_runtime_ensure_failed");
    }
    if (!chat) {
      throw new Error("claimed_tester_bot_unresolved");
    }

    const doctor = await buildTelegramDoctorReport({ chat, envFile, session, topicId });
    proof = {
      ...proof,
      branch: doctor.branch,
      runtime_worktree: doctor.runtime_worktree,
      runtime_commit: doctor.runtime_commit,
      runtime_pid: doctor.runtime_pid,
      runtime_port: doctor.runtime_port,
      runtime_health: doctor.checks.gateway.ok ? "pass" : "fail",
      current_lane_bot: doctor.current_lane_bot,
      failure_reason: doctor.failure_reason,
      failure_reasons: doctor.failure_reasons,
    };
    if (!doctor.ok || !doctor.resolved_chat) {
      throw new Error(doctor.failure_reason ?? "telegram_doctor_failed");
    }

    const marker = `OC_E2E_${scenario.replace(/-/g, "_").toUpperCase()}_${telegramCommandDeps.newRunId()}`;
    if (scenario === "tts-final-caption" || scenario === "progress-plus-tts") {
      ttsEnableResult = await sendAndWaitForAnyReply({
        chat,
        contains: "TTS enabled",
        envFile,
        message: "/tts on",
        senderId: doctor.resolved_chat.chat_id ?? 0,
        session,
        timeoutMs: 45_000,
        topicId,
      });
    }

    if (scenario === "progress-plus-tts" && opts.deterministic === true) {
      if (!ttsEnableResult) {
        throw new Error("tts_enable_anchor_unresolved");
      }
      const helperProfile = await telegramCommandDeps.resolveHelperProfile(repoContext.worktree);
      proof = await runDeterministicProgressPlusTtsScenario({
        chat,
        doctor,
        elapsedMs: telegramCommandDeps.now() - startedAt,
        envFile,
        marker,
        runtimeStateDir: helperProfile.runtimeStateDir,
        runtimePort: doctor.runtime_port ?? runtimeReport.runtime_port,
        session,
        timeoutSeconds,
        topicId,
        triggerSendResult: ttsEnableResult.sendResult,
      });
    } else {
      const message =
        requestedMessage ??
        (await defaultTelegramScenarioMessage({
          scenario,
          marker,
          repoRoot: repoContext.repoRoot,
        }));
      const sendResult = await telegramCommandDeps.runTelegramUserSend({
        chat,
        envFile: envFile ?? undefined,
        message,
        session: session ?? undefined,
      });
      const waitResult = await telegramCommandDeps.runTelegramUserWait({
        chat,
        afterId: sendResult.message.message_id,
        contains: marker,
        envFile: envFile ?? undefined,
        senderId: doctor.resolved_chat.chat_id ?? 0,
        session: session ?? undefined,
        threadAnchor: topicId ?? undefined,
        timeoutMs: timeoutSeconds * 1000,
      });
      const readResult = await telegramCommandDeps.runTelegramUserRead({
        afterId: sendResult.message.message_id,
        chat,
        envFile: envFile ?? undefined,
        limit: 80,
        session: session ?? undefined,
      });

      proof = classifyTelegramFeatureScenario({
        chat,
        doctor,
        elapsedMs: telegramCommandDeps.now() - startedAt,
        marker,
        readResult,
        scenario,
        sendResult,
        waitResult,
      });
    }
  } catch (error) {
    const reason = cleanFailureReason(error);
    proof = {
      ...proof,
      elapsed_ms: telegramCommandDeps.now() - startedAt,
      failure_reason: reason,
      failure_reasons: [...new Set([...proof.failure_reasons, reason])],
      pass_fail_reason: reason,
      mergeReadiness: "insufficient",
    };
  } finally {
    const artifactPath = await writeTelegramScenarioArtifact(repoContext.repoRoot, proof);
    proof = {
      ...proof,
      artifact_path: artifactPath,
    };
  }

  return proof;
}

async function runDeterministicProgressPlusTtsScenario(params: {
  chat: string;
  doctor: TelegramDoctorReport;
  elapsedMs: number;
  envFile: string | null;
  marker: string;
  runtimePort: number | null;
  runtimeStateDir: string;
  session: string | null;
  timeoutSeconds: number;
  topicId: number | null;
  triggerSendResult: TelegramUserSendResult;
}): Promise<TelegramScenarioProof> {
  if (!params.runtimePort) {
    throw new Error("runtime_port_unresolved");
  }
  const botId = params.doctor.resolved_chat?.chat_id ?? 0;
  const botApiChatId = params.doctor.userbot?.user_id ?? null;
  if (!botApiChatId) {
    throw new Error("telegram_user_chat_id_unresolved");
  }
  const progressTexts = [
    `PROGRESS_DO_NOT_VOICE_1 ${params.marker}`,
    `PROGRESS_DO_NOT_VOICE_2 ${params.marker}`,
  ] as const;
  const finalText = `FINAL_ONLY_TTS_MARKER ${params.marker}`;
  const gatewayAuth = await telegramCommandDeps.readGatewayAuth(params.runtimeStateDir);
  const gatewayProof = await telegramCommandDeps.callGateway(
    "channels.telegram.progress-tts-proof",
    {
      chatId: botApiChatId,
      finalText,
      marker: params.marker,
      progressTexts: [...progressTexts],
      replyToMessageId: params.triggerSendResult.message.message_id,
      ...(params.topicId != null ? { messageThreadId: params.topicId } : {}),
      timeoutMs: params.timeoutSeconds * 1000,
    },
    params.runtimePort,
    params.timeoutSeconds * 1000,
    gatewayAuth,
  );
  if (gatewayProof.ok !== true) {
    throw new Error(
      typeof gatewayProof.error === "string"
        ? gatewayProof.error
        : "deterministic_runtime_proof_failed",
    );
  }
  const waitResult = await telegramCommandDeps.runTelegramUserWait({
    chat: params.chat,
    afterId: params.triggerSendResult.message.message_id,
    contains: params.marker,
    envFile: params.envFile ?? undefined,
    senderId: botId,
    session: params.session ?? undefined,
    threadAnchor: params.topicId ?? undefined,
    timeoutMs: params.timeoutSeconds * 1000,
  });
  const readResult = await telegramCommandDeps.runTelegramUserRead({
    afterId: params.triggerSendResult.message.message_id,
    chat: params.chat,
    envFile: params.envFile ?? undefined,
    limit: 80,
    session: params.session ?? undefined,
  });
  return classifyDeterministicProgressPlusTtsScenario({
    chat: params.chat,
    doctor: params.doctor,
    elapsedMs: params.elapsedMs,
    finalText,
    gatewayProof,
    marker: params.marker,
    progressTexts: [...progressTexts],
    readResult,
    sendResult: params.triggerSendResult,
    waitResult,
  });
}

function classifyTelegramSmokeReply(
  text: string | null | undefined,
): TelegramSmokeReplyClassification {
  const normalized = cleanString(text)?.toLowerCase() ?? "";
  if (!normalized) {
    return {
      ok: false,
      failureReason: "blank_reply",
    };
  }

  // Smoke replies need semantic classification, not just "some text arrived".
  // Otherwise quota/pairing/auth blockers masquerade as healthy end-to-end proof.
  if (
    normalized.includes("pairing code:") ||
    normalized.includes("pairing approve telegram") ||
    normalized.includes("access not configured")
  ) {
    return {
      ok: false,
      failureReason: "pairing_required",
    };
  }
  if (
    normalized.includes("ai access is unavailable right now") ||
    normalized.includes("reconnect the credential")
  ) {
    return {
      ok: false,
      failureReason: "ai_access_unavailable",
    };
  }
  if (
    normalized.includes("usage limit reached") ||
    normalized.includes("out of extra usage") ||
    normalized.includes("try again in ~")
  ) {
    return {
      ok: false,
      failureReason: "model_quota_exhausted",
    };
  }

  return {
    ok: true,
    failureReason: null,
  };
}

function parseTesterContractMessage(
  text: string,
  proofId: string,
): ParsedTelegramTesterContractMessage {
  const fields = parseTesterContractFields(text);
  const normalizedProofId = escapeRegExp(proofId);
  const headerPattern = new RegExp(
    `^(STARTING|FINISHED|BLOCKED)\\s+${normalizedProofId}(?:\\s|$)`,
    "i",
  );
  const header = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => headerPattern.test(line));
  if (!header) {
    return { kind: "unrelated", fields };
  }

  const status = header.match(headerPattern)?.[1]?.toUpperCase();
  if (status === "STARTING") {
    return { kind: "starting", fields };
  }
  if (status === "FINISHED") {
    return { kind: "finished", fields };
  }
  if (status === "BLOCKED") {
    return { kind: "blocked", fields };
  }
  return { kind: "unrelated", fields };
}

function parseTesterContractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // The contract intentionally uses shell-friendly key=value tokens. Keep the
  // parser strict enough to reject prose, but permissive across lines so humans
  // and models can format final reports naturally.
  for (const token of text.split(/\s+/g)) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = token.slice(0, separatorIndex).trim();
    const value = token.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    fields[key] = value;
  }
  return fields;
}

function matchesOptionalTelegramTopic(
  message: TelegramUserWaitResult["matched"],
  topicId: number | null,
) {
  if (topicId === null) {
    return true;
  }
  const directTopicId = message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id;
  return (
    directTopicId === topicId ||
    message.reply_to_top_id === topicId ||
    message.reply_to_msg_id === topicId
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendAndWaitForAnyReply(params: {
  chat: string;
  contains?: string;
  envFile: string | null;
  message: string;
  senderId: number;
  session: string | null;
  timeoutMs: number;
  topicId: number | null;
}) {
  const sendResult = await telegramCommandDeps.runTelegramUserSend({
    chat: params.chat,
    envFile: params.envFile ?? undefined,
    message: params.message,
    session: params.session ?? undefined,
  });
  const waitResult = await telegramCommandDeps.runTelegramUserWait({
    chat: params.chat,
    afterId: sendResult.message.message_id,
    contains: params.contains ?? "",
    envFile: params.envFile ?? undefined,
    senderId: params.senderId,
    session: params.session ?? undefined,
    threadAnchor: params.topicId ?? undefined,
    timeoutMs: params.timeoutMs,
  });
  return { sendResult, waitResult };
}

async function defaultTelegramScenarioMessage(params: {
  scenario: TelegramE2eScenarioName;
  marker: string;
  repoRoot: string;
}) {
  if (params.scenario === "tts-final-caption") {
    return [
      "Reply with a final voice/TTS answer if TTS is enabled.",
      `The visible final text or caption must include exactly this marker: ${params.marker}.`,
      "Keep the answer under 80 words.",
    ].join(" ");
  }
  if (params.scenario === "progress-long-task") {
    return [
      "Do a visible multi-step answer before the final response.",
      "Send meaningful progress about the model/agent work before the final answer.",
      `The final answer must include exactly this marker: ${params.marker}.`,
      "Do not use only the phrase Still working.",
    ].join(" ");
  }
  const promptPath = path.join(
    params.repoRoot,
    "scripts/telegram-e2e/prompts/progress-plus-tts-tool-steps.txt",
  );
  if (telegramCommandDeps.fileExists(promptPath)) {
    const template = await telegramCommandDeps.readFile(promptPath);
    return template.replaceAll("{{marker}}", params.marker);
  }
  return [
    "Use visible progress before the final response, then produce a final voice/TTS answer if TTS is enabled.",
    `The visible final text or caption must include exactly this marker: ${params.marker}.`,
    "Keep the final answer under 80 words.",
  ].join(" ");
}

function classifyTelegramFeatureScenario(params: {
  chat: string;
  doctor: TelegramDoctorReport;
  elapsedMs: number;
  marker: string;
  readResult: TelegramUserReadResult;
  scenario: TelegramE2eScenarioName;
  sendResult: TelegramUserSendResult;
  waitResult: TelegramUserWaitResult;
}): TelegramScenarioProof {
  const botId = params.doctor.resolved_chat?.chat_id ?? 0;
  const botMessages = params.readResult.messages
    .filter((message) => message.sender_id === botId)
    .filter((message) => message.message_id > params.sendResult.message.message_id)
    .toSorted((a, b) => a.message_id - b.message_id);
  const finalMessage =
    botMessages.find((message) => message.message_id === params.waitResult.matched.message_id) ??
    params.waitResult.matched;
  const progressMessages = botMessages.filter(
    (message) =>
      message.message_id < finalMessage.message_id &&
      Boolean(cleanString(message.text)) &&
      !message.text.includes(params.marker),
  );
  const finalVisibleText = cleanString(finalMessage.text);
  const emptyVoiceOnlyFinalDetected = !finalVisibleText;
  const progressTexts = progressMessages
    .map((message) => cleanString(message.text))
    .filter((text): text is string => Boolean(text));
  const hasMeaningfulProgress = progressTexts.some((text) => !isWatchdogOnlyProgress(text));
  const hasDeletedTransientProgressCandidate =
    params.scenario === "progress-plus-tts" &&
    progressTexts.length === 0 &&
    finalMessage.message_id > params.sendResult.message.message_id + 1;
  const requiresProgress =
    params.scenario === "progress-long-task" || params.scenario === "progress-plus-tts";
  const requiresTtsCaption =
    params.scenario === "tts-final-caption" || params.scenario === "progress-plus-tts";
  const ttsCaptionOk =
    !requiresTtsCaption ||
    (Boolean(finalVisibleText?.includes(params.marker)) && !emptyVoiceOnlyFinalDetected);
  const progressOk =
    !requiresProgress || hasMeaningfulProgress || hasDeletedTransientProgressCandidate;
  const finalAnswerPresentInReadback = botMessages.some(
    (message) => message.message_id === finalMessage.message_id,
  );
  const finalAnswerPresentAfterCleanup =
    params.scenario === "progress-plus-tts" ? finalAnswerPresentInReadback : null;
  const previewCleanupOk = params.scenario !== "progress-plus-tts" || finalAnswerPresentInReadback;
  const ok = ttsCaptionOk && progressOk && previewCleanupOk;
  const failureReasons = [
    ttsCaptionOk ? null : "final_tts_visible_text_missing",
    progressOk ? null : "meaningful_progress_missing",
    previewCleanupOk ? null : "final_answer_deleted_after_preview_cleanup",
  ].filter((reason): reason is string => Boolean(reason));

  return {
    ok,
    scenario: params.scenario,
    branch: params.doctor.branch,
    runtime_worktree: params.doctor.runtime_worktree,
    runtime_commit: params.doctor.runtime_commit,
    runtime_pid: params.doctor.runtime_pid,
    runtime_port: params.doctor.runtime_port,
    runtime_health: params.doctor.checks.gateway.ok ? "pass" : "fail",
    current_lane_bot: params.doctor.current_lane_bot,
    chat: params.chat,
    topic_id:
      params.waitResult.matched.direct_messages_topic?.topic_id ??
      params.waitResult.matched.direct_messages_topic_id ??
      params.doctor.topic_id,
    sent_message_id: params.sendResult.message.message_id,
    progress_message_ids: progressMessages.map((message) => message.message_id),
    final_message_id: finalMessage.message_id,
    message_ids: uniquePositiveNumbers([
      params.sendResult.message.message_id,
      finalMessage.message_id,
      ...botMessages.map((message) => message.message_id),
    ]),
    matched_by: params.waitResult.matched_by,
    elapsed_ms: params.elapsedMs,
    pass_fail_reason: ok ? "pass" : (failureReasons[0] ?? "scenario_failed"),
    failure_reason: ok ? null : (failureReasons[0] ?? "scenario_failed"),
    failure_reasons: failureReasons,
    artifact_path: null,
    featureScenario: params.scenario,
    mergeReadiness: ok ? "sufficient" : "insufficient",
    final_visible_text: finalVisibleText,
    empty_voice_only_final_detected: emptyVoiceOnlyFinalDetected,
    final_answer_present_after_cleanup: finalAnswerPresentAfterCleanup,
    progress_texts: progressTexts,
  };
}

function classifyDeterministicProgressPlusTtsScenario(params: {
  chat: string;
  doctor: TelegramDoctorReport;
  elapsedMs: number;
  finalText: string;
  gatewayProof: Record<string, unknown>;
  marker: string;
  progressTexts: string[];
  readResult: TelegramUserReadResult;
  sendResult: TelegramUserSendResult;
  waitResult: TelegramUserWaitResult;
}): TelegramScenarioProof {
  const botId = params.doctor.resolved_chat?.chat_id ?? 0;
  const botMessages = params.readResult.messages
    .filter((message) => message.sender_id === botId)
    .filter((message) => message.message_id > params.sendResult.message.message_id)
    .toSorted((a, b) => a.message_id - b.message_id);
  const finalMessage =
    botMessages.find((message) => cleanString(message.text) === params.finalText) ??
    params.waitResult.matched;
  const durableProgressTexts = botMessages
    .map((message) => cleanString(message.text))
    .filter((text): text is string =>
      Boolean(text && params.progressTexts.some((progressText) => text.includes(progressText))),
    );
  const audioMessagesAfterFinal = botMessages.filter(
    (message) =>
      message.message_id > finalMessage.message_id &&
      (message.media_kind === "voice" || message.media_kind === "audio"),
  );
  const audioMessage = audioMessagesAfterFinal[0];
  const audioCaptionText = cleanString(audioMessage?.text);
  const progressTransientMessageId = parseOptionalPositiveInt(
    params.gatewayProof.progress_message_id,
  );
  const progressExisted = progressTransientMessageId !== null;
  const progressWasDeleted =
    progressTransientMessageId !== null &&
    Array.isArray(params.gatewayProof.deleted_message_ids) &&
    params.gatewayProof.deleted_message_ids.includes(progressTransientMessageId);
  const finalVisibleText = cleanString(finalMessage.text);
  const finalOk = finalVisibleText === params.finalText;
  const audioCountOk = audioMessagesAfterFinal.length === 1 && Boolean(audioMessage);
  const audioCaptionOk = Boolean(audioCaptionText) && audioCaptionText === params.finalText;
  const audioOk = audioCountOk && audioCaptionOk;
  const progressOk = progressExisted && progressWasDeleted && durableProgressTexts.length === 0;
  const ok = finalOk && audioOk && progressOk;
  const failureReasons = [
    progressExisted ? null : "progress_transient_message_missing",
    progressWasDeleted ? null : "progress_transient_message_not_deleted",
    durableProgressTexts.length === 0 ? null : "progress_poison_text_durable",
    finalOk ? null : "final_text_missing_or_changed",
    audioCountOk ? null : "exactly_one_audio_after_final_missing",
    audioCaptionOk ? null : "audio_caption_missing_or_changed",
  ].filter((reason): reason is string => Boolean(reason));

  return {
    ok,
    scenario: "progress-plus-tts",
    branch: params.doctor.branch,
    runtime_worktree: params.doctor.runtime_worktree,
    runtime_commit: params.doctor.runtime_commit,
    runtime_pid: params.doctor.runtime_pid,
    runtime_port: params.doctor.runtime_port,
    runtime_health: params.doctor.checks.gateway.ok ? "pass" : "fail",
    current_lane_bot: params.doctor.current_lane_bot,
    chat: params.chat,
    topic_id:
      params.waitResult.matched.direct_messages_topic?.topic_id ??
      params.waitResult.matched.direct_messages_topic_id ??
      params.doctor.topic_id,
    sent_message_id: params.sendResult.message.message_id,
    progress_message_ids: progressTransientMessageId ? [progressTransientMessageId] : [],
    final_message_id: finalMessage.message_id,
    message_ids: uniquePositiveNumbers([
      params.sendResult.message.message_id,
      progressTransientMessageId ?? 0,
      finalMessage.message_id,
      audioMessage?.message_id ?? 0,
      ...botMessages.map((message) => message.message_id),
    ]),
    matched_by: params.waitResult.matched_by,
    elapsed_ms: params.elapsedMs,
    pass_fail_reason: ok ? "pass" : (failureReasons[0] ?? "deterministic_scenario_failed"),
    failure_reason: ok ? null : (failureReasons[0] ?? "deterministic_scenario_failed"),
    failure_reasons: failureReasons,
    artifact_path: null,
    featureScenario: "progress-plus-tts",
    mergeReadiness: ok ? "sufficient" : "insufficient",
    final_visible_text: finalVisibleText,
    empty_voice_only_final_detected: !finalVisibleText,
    final_answer_present_after_cleanup: finalOk,
    progress_texts: params.progressTexts,
    deterministic: true,
    final_marker: params.marker,
    poison_progress_strings: params.progressTexts,
    progress_transient_message_id: progressTransientMessageId,
    audio_message_id: audioMessage?.message_id ?? null,
    audio_message_kind: audioMessage?.media_kind ?? null,
    audio_caption_text: audioCaptionText ?? null,
    durable_progress_texts: durableProgressTexts,
    gateway_proof: params.gatewayProof,
  };
}

function isWatchdogOnlyProgress(text: string) {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "still working." ||
    normalized === "still working..." ||
    normalized === "still working on it. this is taking longer than usual."
  );
}

function uniquePositiveNumbers(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))];
}

async function writeTelegramSmokeArtifact(
  repoRoot: string,
  proof: TelegramSmokeProof,
): Promise<string> {
  // Write an artifact for both pass and fail cases so every smoke run leaves a
  // durable proof record instead of forcing operators to scrape terminal logs.
  const artifactPath = buildTelegramSmokeArtifactPath(
    repoRoot,
    proof.scenario,
    telegramCommandDeps.newRunId(),
    new Date(telegramCommandDeps.now()),
  );
  await telegramCommandDeps.writeFile(artifactPath, `${JSON.stringify(proof, null, 2)}\n`);
  return artifactPath;
}

async function writeTelegramScenarioArtifact(
  repoRoot: string,
  proof: TelegramScenarioProof,
): Promise<string> {
  const artifactPath = buildTelegramSmokeArtifactPath(
    repoRoot,
    proof.scenario,
    telegramCommandDeps.newRunId(),
    new Date(telegramCommandDeps.now()),
  );
  await telegramCommandDeps.writeFile(artifactPath, `${JSON.stringify(proof, null, 2)}\n`);
  return artifactPath;
}

function renderDoctorText(report: TelegramDoctorReport): string {
  const lines = [
    report.ok
      ? "Telegram doctor ok."
      : `Telegram doctor failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_pid=${report.runtime_pid ?? "-"}`,
    `runtime_port=${report.runtime_port ?? "-"}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
  ];
  if (report.chat) {
    lines.push(`chat=${report.chat}`);
  }
  if (report.topic_id !== null) {
    lines.push(`topic_id=${report.topic_id}`);
  }
  for (const [name, check] of Object.entries(report.checks)) {
    if (!check) {
      continue;
    }
    lines.push(
      `check.${name}=${check.ok ? "ok" : `fail reason=${check.failure_reason ?? "unknown"}`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderRuntimeText(report: TelegramRuntimeReport): string {
  const lines = [
    report.ok
      ? `Telegram runtime ${report.action} ok.`
      : `Telegram runtime ${report.action} failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_pid=${report.runtime_pid ?? "-"}`,
    `runtime_port=${report.runtime_port ?? "-"}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function renderSmokeText(report: TelegramSmokeProof): string {
  const lines = [
    report.ok
      ? "Telegram smoke dm-reply ok."
      : `Telegram smoke dm-reply failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `artifact_path=${report.artifact_path ?? "-"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_pid=${report.runtime_pid ?? "-"}`,
    `runtime_port=${report.runtime_port ?? "-"}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
    `chat=${report.chat ?? "-"}`,
    `topic_id=${report.topic_id ?? "-"}`,
    `sent_message_id=${report.sent_message_id ?? "-"}`,
    `reply_message_id=${report.reply_message_id ?? "-"}`,
    `matched_by=${report.matched_by ?? "-"}`,
    `elapsed_ms=${report.elapsed_ms}`,
  ];
  if (report.reply_text) {
    lines.push(`reply_text=${report.reply_text}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderBaselineText(report: TelegramBaselineProof): string {
  const lines = [
    report.ok
      ? "Telegram smoke baseline ok."
      : `Telegram smoke baseline failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `baseline=${report.baseline}`,
    `featureScenario=${report.featureScenario}`,
    `mergeReadiness=${report.mergeReadiness}`,
    `artifact_path=${report.artifact_path ?? "-"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_health=${report.ok ? "pass" : "fail"}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
    `sent_message_id=${report.sent_message_id ?? "-"}`,
    `reply_message_id=${report.reply_message_id ?? "-"}`,
    `pass_fail_reason=${report.failure_reason ?? "pass"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function renderTesterReplyContractText(report: TelegramTesterReplyContractProof): string {
  const lines = [
    report.ok
      ? "Telegram smoke reply-contract ok."
      : `Telegram smoke reply-contract failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `proof_id=${report.proof_id}`,
    `artifact_path=${report.artifact_path ?? "-"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_pid=${report.runtime_pid ?? "-"}`,
    `runtime_port=${report.runtime_port ?? "-"}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
    `chat=${report.chat ?? "-"}`,
    `sent_message_id=${report.sent_message_id ?? "-"}`,
    `starting_message_id=${report.starting_message_id ?? "-"}`,
    `final_message_id=${report.final_message_id ?? "-"}`,
    `final_status=${report.final_status}`,
    `last_step=${report.last_step ?? "-"}`,
    `required_fields=${report.required_fields.join(",")}`,
  ];
  if (report.reply_text) {
    lines.push(`reply_text=${report.reply_text}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderScenarioText(report: TelegramScenarioProof): string {
  const lines = [
    report.ok
      ? `Telegram scenario ${report.scenario} ok.`
      : `Telegram scenario ${report.scenario} failed. failure_reason=${report.failure_reason ?? "unknown"}`,
    `featureScenario=${report.featureScenario}`,
    `mergeReadiness=${report.mergeReadiness}`,
    `artifact_path=${report.artifact_path ?? "-"}`,
    `branch=${report.branch ?? "-"}`,
    `runtime_worktree=${report.runtime_worktree ?? "-"}`,
    `runtime_commit=${report.runtime_commit ?? "-"}`,
    `runtime_health=${report.runtime_health}`,
    `current_lane_bot=${report.current_lane_bot ?? "-"}`,
    `sent_message_id=${report.sent_message_id ?? "-"}`,
    ...(report.progress_transient_message_id != null
      ? [`progress_transient_message_id=${report.progress_transient_message_id}`]
      : []),
    `progress_message_ids=${report.progress_message_ids.join(",") || "-"}`,
    `final_message_id=${report.final_message_id ?? "-"}`,
    ...(report.audio_message_id != null ? [`audio_message_id=${report.audio_message_id}`] : []),
    `message_ids=${report.message_ids.join(",") || "-"}`,
    `pass_fail_reason=${report.pass_fail_reason}`,
  ];
  if (report.final_visible_text) {
    lines.push(`final_visible_text=${report.final_visible_text}`);
  }
  return `${lines.join("\n")}\n`;
}

function logTelegramPayload<T>(
  runtime: RuntimeEnv,
  payload: T,
  json: boolean,
  renderText: (payload: T) => string,
) {
  runtime.log(json ? JSON.stringify(payload, null, 2) : renderText(payload));
}

function buildTokenClaimCheck(
  worktreePath: string,
  token: string | null,
  tokenClaimPaths: string[],
  botIdentity: TelegramBotIdentity | null,
): TelegramDoctorCheck {
  if (!token) {
    return {
      ok: false,
      failure_reason: "tester_bot_token_missing",
    };
  }
  if (tokenClaimPaths.length !== 1) {
    return {
      ok: false,
      failure_reason: `tester_bot_token_claim_conflict:${tokenClaimPaths.length}`,
      details: { claim_paths: tokenClaimPaths },
    };
  }
  if (path.resolve(tokenClaimPaths[0]) !== path.resolve(worktreePath)) {
    return {
      ok: false,
      failure_reason: "tester_bot_token_claim_owned_elsewhere",
      details: { claim_paths: tokenClaimPaths },
    };
  }
  return {
    ok: true,
    failure_reason: null,
    details: {
      bot_id: botIdentity?.id ?? null,
      bot_username: botIdentity?.username ?? null,
    },
  };
}

function buildTopicCheck(chat: string | null, topicId: number | null): TelegramDoctorCheck {
  if (topicId === null) {
    return {
      ok: true,
      failure_reason: null,
    };
  }
  if (!chat) {
    return {
      ok: false,
      failure_reason: "topic_id_requires_chat",
    };
  }
  if (topicId <= 0) {
    return {
      ok: false,
      failure_reason: "topic_id_invalid",
    };
  }
  return {
    ok: true,
    failure_reason: null,
    details: { topic_id: topicId },
  };
}

function firstTelegramFailureReason(checks: Array<TelegramDoctorCheck | undefined>): string | null {
  for (const check of checks) {
    if (check && !check.ok) {
      return check.failure_reason ?? "telegram_check_failed";
    }
  }
  return null;
}

function checksToFailureReasons(checks: Array<TelegramDoctorCheck | undefined>): string[] {
  return checks
    .filter((check): check is TelegramDoctorCheck =>
      Boolean(check && !check.ok && check.failure_reason),
    )
    .map((check) => check.failure_reason as string);
}

function formatCurrentLaneBot(identity: TelegramBotIdentity | null, token: string | null) {
  if (identity?.username) {
    return `@${identity.username}`;
  }
  if (identity?.id) {
    return `id=${identity.id}`;
  }
  if (token?.includes(":")) {
    return `id=${token.split(":")[0]}`;
  }
  return null;
}

function cleanFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "telegram_command_failed";
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseOptionalPositiveInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getLastField(fields: Record<string, string | string[]>, keys: string[]): string | null {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value) && value.length > 0) {
      const last = value.at(-1);
      if (typeof last === "string" && last.trim()) {
        return last.trim();
      }
    }
  }
  return null;
}

async function readLastEnvValue(filePath: string, key: string): Promise<string | null> {
  if (!telegramCommandDeps.fileExists(filePath)) {
    return null;
  }
  const content = await telegramCommandDeps.readFile(filePath);
  let lastValue: string | null = null;
  for (const rawLine of content.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`));
    if (!match) {
      continue;
    }
    const value = stripOuterQuotes(match[1].trim());
    if (value) {
      lastValue = value;
    }
  }
  return lastValue;
}

function stripOuterQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function resolveTelegramRepoRoot(): Promise<string> {
  const importDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    path.resolve(importDir, "..", ".."),
    path.resolve(importDir, "..", "..", ".."),
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "scripts", "telegram-e2e", "requirements.txt"))) {
      return path.resolve(candidate);
    }
  }

  throw new Error("Could not locate the repo root for Telegram live tooling.");
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await telegramCommandDeps.exec(["git", ...args], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function execCommandAllowFailure(args: string[]) {
  try {
    const { stdout, stderr } = await telegramCommandDeps.exec(args);
    return { stdout, stderr };
  } catch (error) {
    return {
      stdout:
        typeof error === "object" && error && "stdout" in error
          ? String((error as { stdout?: string }).stdout ?? "")
          : "",
      stderr:
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr?: string }).stderr ?? "")
          : "",
    };
  }
}

function defaultTelegramUserSessionPath(repoRoot: string) {
  return path.join(repoRoot, "scripts", "telegram-e2e", "tmp", "userbot.session");
}
