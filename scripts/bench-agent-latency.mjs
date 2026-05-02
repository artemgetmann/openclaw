#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BACKENDS = ["claude-bridge", "claude-cli", "codex"];
const DEFAULT_PROMPT = "Reply with exactly one short sentence: benchmark ok.";
const DEFAULT_FOLLOW_UP = "Reply with exactly one short sentence: follow-up ok.";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RUNS_WITHOUT_OVERRIDE = 3;

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function help() {
  return [
    "Usage: node scripts/bench-agent-latency.mjs [options]",
    "",
    "Dry run is the default. Live provider calls require --live or OPENCLAW_BACKEND_BENCH_LIVE=1.",
    "",
    "Options:",
    "  --live                         Run real provider calls.",
    "  --backend <all|name[,name]>    Backends: claude-bridge, claude-cli, codex. Default: all.",
    "  --runs <n>                     Runs per backend. Default: 1. Values >3 require --allow-many.",
    "  --allow-many                   Allow more than 3 live runs.",
    "  --prompt <text>                Initial prompt.",
    "  --follow-up [text]             Measure one follow-up turn where possible.",
    "  --timeout-ms <n>               Per-turn timeout. Default: 120000.",
    "  --workspace <path>             Workspace for CLI processes. Default: temp dir.",
    "  --claude-command <cmd>         Claude CLI command. Default: claude.",
    "  --claude-model <model>         Claude model. Default: sonnet.",
    "  --codex-command <cmd>          Codex CLI command. Default: codex.",
    "  --codex-model <model>          Codex model. Default: gpt-5.1-codex-mini.",
    "  --json                         Print final metrics as JSON only.",
    "  --help                         Show this help.",
  ].join("\n");
}

function parsePositiveInt(raw, fallback) {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBackends(raw) {
  if (!raw || raw.trim().toLowerCase() === "all") {
    return BACKENDS;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = parsed.filter((entry) => !BACKENDS.includes(entry));
  if (unknown.length > 0) {
    throw new Error(`Unknown backend(s): ${unknown.join(", ")}`);
  }
  return parsed;
}

async function parseOptions() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(help());
    process.exit(0);
  }
  const runs = parsePositiveInt(readFlag("--runs"), 1);
  const allowMany = hasFlag("--allow-many");
  if (runs > MAX_RUNS_WITHOUT_OVERRIDE && !allowMany) {
    throw new Error(`--runs ${runs} is blocked by default. Add --allow-many if intentional.`);
  }
  const workspace =
    readFlag("--workspace") ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backend-bench-")));
  await fs.mkdir(workspace, { recursive: true });
  return {
    live: hasFlag("--live") || process.env.OPENCLAW_BACKEND_BENCH_LIVE === "1",
    backends: parseBackends(readFlag("--backend")),
    runs,
    timeoutMs: parsePositiveInt(readFlag("--timeout-ms"), DEFAULT_TIMEOUT_MS),
    workspace,
    prompt: readFlag("--prompt") ?? DEFAULT_PROMPT,
    followUp: hasFlag("--follow-up") ? (readFlag("--follow-up") ?? DEFAULT_FOLLOW_UP) : undefined,
    claudeCommand: readFlag("--claude-command") ?? "claude",
    claudeModel: readFlag("--claude-model") ?? "sonnet",
    codexCommand: readFlag("--codex-command") ?? "codex",
    codexModel: readFlag("--codex-model") ?? "gpt-5.1-codex-mini",
    json: hasFlag("--json"),
  };
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function markStart(state) {
  state.assistantStartMs ??= elapsedMs(state.startedAt);
}

function markText(state, text) {
  if (!text.trim()) {
    return;
  }
  markStart(state);
  state.firstVisibleTextMs ??= elapsedMs(state.startedAt);
  state.text = text;
}

function collectText(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (typeof value !== "object") {
    return "";
  }
  return (
    collectText(value.text) ||
    collectText(value.result) ||
    collectText(value.content) ||
    collectText(value.message) ||
    collectText(value.item) ||
    collectText(value.delta)
  );
}

function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readClaudeDelta(event) {
  if (event.type !== "stream_event") {
    return "";
  }
  const streamEvent = event.event;
  if (!streamEvent || typeof streamEvent !== "object") {
    return "";
  }
  if (streamEvent.type !== "content_block_delta") {
    return "";
  }
  const delta = streamEvent.delta;
  if (!delta || typeof delta !== "object") {
    return "";
  }
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function parseClaudeLine(line, state) {
  const event = parseJsonLine(line);
  if (!event) {
    return false;
  }
  if (event.type === "assistant") {
    markStart(state);
    markText(state, collectText(event.message ?? event));
    return false;
  }
  if (event.type === "stream_event") {
    const message = event.event?.message;
    if (event.event?.type === "message_start" && message?.role === "assistant") {
      markStart(state);
    }
    const delta = readClaudeDelta(event);
    if (delta) {
      markText(state, `${state.text}${delta}`);
    }
    return false;
  }
  if (event.type !== "result") {
    return false;
  }
  markText(state, collectText(event.result) || state.text);
  if (typeof event.session_id === "string" && event.session_id.trim()) {
    state.sessionId = event.session_id.trim();
  }
  return true;
}

function parseCodexLine(line, state) {
  const event = parseJsonLine(line);
  if (!event) {
    return false;
  }
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const item = event.item && typeof event.item === "object" ? event.item : {};
  const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
  const itemRole = typeof item.role === "string" ? item.role.toLowerCase() : "";
  if (type.includes("assistant") || itemRole === "assistant") {
    markStart(state);
  }
  if (typeof event.thread_id === "string" && event.thread_id.trim()) {
    state.sessionId = event.thread_id.trim();
  }
  const visible =
    collectText(event.delta) ||
    (type.includes("message") || itemType.includes("message") || itemRole === "assistant"
      ? collectText(event)
      : "");
  markText(state, visible || state.text);
  return type.includes("completed") || type === "turn.complete" || type === "response.completed";
}

function claudeInput(prompt) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  })}\n`;
}

function claudeArgs(options, sessionId) {
  const args = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push("--model", options.claudeModel);
  return args;
}

function finish(state, ok, error) {
  return {
    backend: state.backend,
    turn: state.turn,
    run: state.run,
    ok,
    assistantStartMs: state.assistantStartMs,
    firstVisibleTextMs: state.firstVisibleTextMs,
    totalMs: elapsedMs(state.startedAt),
    textChars: state.text.length,
    sessionId: state.sessionId,
    error,
  };
}

async function runJsonlProcess(params) {
  const state = {
    backend: params.backend,
    turn: params.turn,
    run: params.run,
    startedAt: process.hrtime.bigint(),
    text: "",
  };
  return await new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(finish(state, false, `timeout after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        params.parseLine(line, state);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(finish(state, false, error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0 && Boolean(state.text.trim());
      resolve(
        finish(
          state,
          ok,
          ok
            ? undefined
            : stderr.trim() || `exit code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
    child.stdin.end(params.input ?? "");
  });
}

async function runTextProcess(params) {
  const state = {
    backend: params.backend,
    turn: params.turn,
    run: params.run,
    startedAt: process.hrtime.bigint(),
    text: "",
  };
  return await new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(finish(state, false, `timeout after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      markText(state, stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(finish(state, false, error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0 && Boolean(stdout.trim());
      resolve(
        finish(
          state,
          ok,
          ok
            ? undefined
            : stderr.trim() || `exit code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

class ClaudeBridge {
  constructor(options) {
    this.options = options;
    this.buffer = "";
    this.child = undefined;
    this.active = undefined;
  }

  async run(turn, run, prompt) {
    this.start();
    if (!this.child) {
      throw new Error("Claude bridge child did not start.");
    }
    const state = {
      backend: "claude-bridge",
      turn,
      run,
      startedAt: process.hrtime.bigint(),
      text: "",
    };
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child?.kill("SIGKILL");
        this.active = undefined;
        resolve(finish(state, false, `timeout after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.active = { state, resolve, timer };
      this.child.stdin.write(claudeInput(prompt));
    });
  }

  stop() {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  start() {
    if (this.child) {
      return;
    }
    const child = spawn(this.options.claudeCommand, claudeArgs(this.options), {
      cwd: this.options.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.buffer.indexOf("\n");
      }
    });
    child.on("close", (code, signal) => {
      const active = this.active;
      this.active = undefined;
      this.child = undefined;
      if (!active) {
        return;
      }
      clearTimeout(active.timer);
      active.resolve(
        finish(
          active.state,
          false,
          `bridge process exited early code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  }

  handleLine(line) {
    if (!this.active) {
      return;
    }
    if (!parseClaudeLine(line, this.active.state)) {
      return;
    }
    const active = this.active;
    clearTimeout(active.timer);
    this.active = undefined;
    active.resolve(finish(active.state, true));
  }
}

async function runClaudeCli(options, turn, run, prompt, sessionId) {
  return await runJsonlProcess({
    backend: "claude-cli",
    turn,
    run,
    command: options.claudeCommand,
    args: claudeArgs(options, sessionId),
    input: claudeInput(prompt),
    cwd: options.workspace,
    timeoutMs: options.timeoutMs,
    parseLine: parseClaudeLine,
  });
}

async function runCodex(options, turn, run, prompt, sessionId) {
  if (sessionId) {
    return await runTextProcess({
      backend: "codex",
      turn,
      run,
      command: options.codexCommand,
      args: [
        "exec",
        "resume",
        sessionId,
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--model",
        options.codexModel,
        prompt,
      ],
      cwd: options.workspace,
      timeoutMs: options.timeoutMs,
    });
  }
  return await runJsonlProcess({
    backend: "codex",
    turn,
    run,
    command: options.codexCommand,
    args: [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      options.codexModel,
      prompt,
    ],
    cwd: options.workspace,
    timeoutMs: options.timeoutMs,
    parseLine: parseCodexLine,
  });
}

function formatMs(value) {
  return value == null ? "-" : `${value.toFixed(1)}ms`;
}

function printDryRun(options) {
  console.log("Dry run. Add --live or OPENCLAW_BACKEND_BENCH_LIVE=1 to call providers.");
  console.log(`Workspace: ${options.workspace}`);
  console.log(`Runs: ${options.runs}`);
  console.log(`Follow-up: ${options.followUp ? "yes" : "no"}`);
  console.log("");
  for (const backend of options.backends) {
    if (backend === "codex") {
      console.log(
        `codex:         ${options.codexCommand} exec --json --color never --sandbox read-only --skip-git-repo-check --model ${options.codexModel} <prompt>`,
      );
    } else {
      console.log(
        `${backend.padEnd(13)} ${options.claudeCommand} ${claudeArgs(options).join(
          " ",
        )} <stream-json stdin>`,
      );
    }
  }
}

function printMetric(metric) {
  const status = metric.ok ? "ok" : "fail";
  console.log(
    [
      metric.backend.padEnd(13),
      metric.turn.padEnd(9),
      `run=${String(metric.run).padEnd(2)}`,
      status.padEnd(4),
      `start=${formatMs(metric.assistantStartMs).padEnd(9)}`,
      `text=${formatMs(metric.firstVisibleTextMs).padEnd(9)}`,
      `total=${formatMs(metric.totalMs).padEnd(9)}`,
      `chars=${metric.textChars}`,
      metric.error ? `error=${metric.error}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function printSummary(metrics) {
  const successful = metrics.filter((metric) => metric.ok);
  if (successful.length === 0) {
    return;
  }
  console.log("");
  console.log("Summary p50 (successful runs)");
  for (const backend of BACKENDS) {
    for (const turn of ["initial", "follow-up"]) {
      const rows = successful.filter(
        (metric) => metric.backend === backend && metric.turn === turn,
      );
      if (rows.length === 0) {
        continue;
      }
      const p50 = (values) => {
        const sorted = values.toSorted((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      console.log(
        `${backend.padEnd(13)} ${turn.padEnd(9)} start=${formatMs(
          p50(rows.map((row) => row.assistantStartMs ?? row.totalMs)),
        )} text=${formatMs(
          p50(rows.map((row) => row.firstVisibleTextMs ?? row.totalMs)),
        )} total=${formatMs(p50(rows.map((row) => row.totalMs)))}`,
      );
    }
  }
}

async function runLive(options) {
  const metrics = [];
  if (!options.json) {
    console.log(`Workspace: ${options.workspace}`);
    console.log(`Backends: ${options.backends.join(", ")}`);
    console.log(`Runs: ${options.runs}`);
    console.log("");
  }

  for (let run = 1; run <= options.runs; run += 1) {
    for (const backend of options.backends) {
      if (backend === "claude-bridge") {
        const bridge = new ClaudeBridge(options);
        try {
          const initial = await bridge.run("initial", run, options.prompt);
          metrics.push(initial);
          if (!options.json) {
            printMetric(initial);
          }
          if (options.followUp && initial.ok) {
            const followUp = await bridge.run("follow-up", run, options.followUp);
            metrics.push(followUp);
            if (!options.json) {
              printMetric(followUp);
            }
          }
        } finally {
          bridge.stop();
        }
        continue;
      }
      if (backend === "claude-cli") {
        const initial = await runClaudeCli(options, "initial", run, options.prompt);
        metrics.push(initial);
        if (!options.json) {
          printMetric(initial);
        }
        if (options.followUp && initial.ok) {
          const followUp = await runClaudeCli(
            options,
            "follow-up",
            run,
            options.followUp,
            initial.sessionId,
          );
          metrics.push(followUp);
          if (!options.json) {
            printMetric(followUp);
          }
        }
        continue;
      }
      const initial = await runCodex(options, "initial", run, options.prompt);
      metrics.push(initial);
      if (!options.json) {
        printMetric(initial);
      }
      if (options.followUp && initial.ok) {
        const followUp = await runCodex(
          options,
          "follow-up",
          run,
          options.followUp,
          initial.sessionId,
        );
        metrics.push(followUp);
        if (!options.json) {
          printMetric(followUp);
        }
      }
    }
  }

  if (!options.json) {
    printSummary(metrics);
    console.log("");
  }
  console.log(JSON.stringify({ metrics }, null, 2));
}

async function main() {
  const options = await parseOptions();
  if (!options.live) {
    printDryRun(options);
    return;
  }
  await runLive(options);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
