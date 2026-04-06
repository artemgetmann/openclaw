import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { RuntimeEnv } from "../runtime.js";
import { runTelegramUserPrecheck, runTelegramUserSend } from "../telegram-user/backend.js";
import type {
  TelegramUserPrecheck,
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
  scenario: "dm-reply";
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

type TelegramSmokeReplyClassification = {
  ok: boolean;
  failureReason: string | null;
};

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

type TelegramBotIdentity = {
  id: number | null;
  username: string | null;
  name: string | null;
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
  runTelegramUserSend,
  runTelegramUserWait,
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
      envFile: cleanString(opts.envFile),
      session: cleanString(opts.session),
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
      envFile: cleanString(opts.envFile) ?? undefined,
      message,
      session: cleanString(opts.session) ?? undefined,
    });
    const waitResult = await telegramCommandDeps.runTelegramUserWait({
      chat,
      afterId: sendResult.message.message_id,
      contains: "",
      envFile: cleanString(opts.envFile) ?? undefined,
      senderId: doctor.resolved_chat.chat_id ?? 0,
      session: cleanString(opts.session) ?? undefined,
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

  let userbotPrecheck: TelegramUserPrecheck | null = null;
  let userbotFailureReason: string | null = null;
  try {
    userbotPrecheck = await telegramCommandDeps.runTelegramUserPrecheck({
      ...(params.envFile ? { envFile: params.envFile } : {}),
      ...(params.session ? { session: params.session } : {}),
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
        ...(params.envFile ? { envFile: params.envFile } : {}),
        ...(params.session ? { session: params.session } : {}),
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

function classifyTelegramSmokeReply(
  text: string | null | undefined,
): TelegramSmokeReplyClassification {
  const normalized = cleanString(text)?.toLowerCase() ?? "";
  if (!normalized) {
    return {
      ok: true,
      failureReason: null,
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
