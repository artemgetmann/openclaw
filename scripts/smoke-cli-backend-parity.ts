#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;

type ScenarioId = "codex-context" | "memory-chain" | "browser-open-snapshot" | "latency";

type Scenario = {
  id: ScenarioId;
  label: string;
  mode: string;
};

type ScenarioRow = {
  scenario: ScenarioId;
  label: string;
  status: "pass" | "fail" | "dry-run";
  ok: boolean;
  command: string;
  durationMs?: number;
  workspaceDir: string;
  summary?: Record<string, unknown>;
  error?: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "codex-context",
    label: "Codex/OpenAI turn shared into Claude CLI context",
    mode: "codex-context",
  },
  {
    id: "memory-chain",
    label: "Claude CLI memory_search to memory_get tool chain",
    mode: "memory-chain",
  },
  {
    id: "browser-open-snapshot",
    label: "Claude CLI browser open plus snapshot tool proof",
    mode: "browser-open-snapshot",
  },
  {
    id: "latency",
    label: "Claude CLI warm-session latency proof",
    mode: "latency",
  },
];

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function help(): string {
  return [
    "Usage: node --import tsx scripts/smoke-cli-backend-parity.ts [options]",
    "",
    "Dry run is the default. Live provider/browser calls require --live or OPENCLAW_CLI_BACKEND_PARITY_LIVE=1.",
    "",
    "Options:",
    "  --live                         Run the parity matrix.",
    "  --scenario <id[,id]>           Run selected scenarios. Default: all.",
    "  --workspace <path>             Base workspace for child smoke runs. Default: temp dir.",
    "  --timeout-ms <n>               Per child smoke timeout. Default: 180000.",
    "  --model <model>                Claude CLI model forwarded to child smokes. Default: child default.",
    "  --codex-model <model>          Codex model forwarded to codex-context smoke. Default: child default.",
    "  --help                         Show this help.",
    "",
    `Scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}`,
  ].join("\n");
}

function parseScenarios(): Scenario[] {
  const raw = readFlag("--scenario");
  if (!raw || raw.trim().toLowerCase() === "all") {
    return SCENARIOS;
  }
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  }
  return ids.map((id) => SCENARIOS.find((scenario) => scenario.id === id)!);
}

async function parseOptions() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(help());
    process.exit(0);
  }
  const workspace =
    readFlag("--workspace") ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-backend-parity-")));
  await fs.mkdir(workspace, { recursive: true });
  return {
    live: hasFlag("--live") || process.env.OPENCLAW_CLI_BACKEND_PARITY_LIVE === "1",
    scenarios: parseScenarios(),
    workspace,
    timeoutMs: parsePositiveInt(readFlag("--timeout-ms"), DEFAULT_TIMEOUT_MS),
    model: readFlag("--model"),
    codexModel: readFlag("--codex-model"),
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandFor(args: string[]): string {
  return [process.execPath, ...args].map(shellQuote).join(" ");
}

function findJsonObject(text: string): Record<string, unknown> | undefined {
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    try {
      const parsed = JSON.parse(text.slice(index));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      // Child smokes print JSON last; earlier braces can appear in stack traces.
    }
  }
  return undefined;
}

function summarizeChild(output: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: output.mode,
    provider: output.provider,
    firstProvider: output.firstProvider,
    secondProvider: output.secondProvider,
    model: output.model,
    firstModel: output.firstModel,
    secondModel: output.secondModel,
    nonce: output.nonce,
    workspaceDir: output.workspaceDir,
    sessionFile: output.sessionFile,
    claudeSessionId: output.claudeSessionId,
    sameClaudeSessionId: output.sameClaudeSessionId,
    liveProcess: output.liveProcess,
    targetUrl: output.targetUrl,
    pageMarker: output.pageMarker,
    memoryNeedle: output.memoryNeedle,
    indexedMemoryPath: output.indexedMemoryPath,
    codex: output.codex,
    claude: output.claude,
    turn1: output.turn1,
    turn2: output.turn2,
  };
}

async function runScenario(
  scenario: Scenario,
  options: Awaited<ReturnType<typeof parseOptions>>,
): Promise<ScenarioRow> {
  const workspaceDir = path.join(options.workspace, scenario.id);
  await fs.mkdir(workspaceDir, { recursive: true });

  const args = [
    "--import",
    "tsx",
    "scripts/smoke-claude-cli-continuity.ts",
    "--live",
    "--mode",
    scenario.mode,
    "--timeout-ms",
    String(options.timeoutMs),
    "--workspace",
    workspaceDir,
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.codexModel && scenario.id === "codex-context") {
    args.push("--codex-model", options.codexModel);
  }

  const startedAt = process.hrtime.bigint();
  const command = commandFor(args);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // The child smoke has its own operation timeout, but this wrapper also needs
  // a parent-level watchdog so the parity matrix itself cannot hang forever.
  const watchdogMs = options.timeoutMs + 30_000;
  let timedOut = false;
  let closed = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  }, watchdogMs);
  watchdog.unref();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    },
  );
  clearTimeout(watchdog);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const childJson = findJsonObject(stdout);
  const childOk = childJson?.ok === true;
  const ok = exit.code === 0 && childOk;

  return {
    scenario: scenario.id,
    label: scenario.label,
    status: ok ? "pass" : "fail",
    ok,
    command,
    durationMs,
    workspaceDir,
    summary: childJson ? summarizeChild(childJson) : undefined,
    error: ok
      ? undefined
      : [
          exit.code === 0
            ? undefined
            : `exit code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`,
          timedOut ? `parent watchdog timed out after ${watchdogMs}ms` : undefined,
          stderr.trim(),
          stdout.trim() && !childJson ? stdout.trim() : undefined,
          childJson && childJson.ok !== true ? JSON.stringify(childJson) : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000),
  };
}

async function main(): Promise<void> {
  const options = await parseOptions();
  const dryRunRows: ScenarioRow[] = options.scenarios.map((scenario) => {
    const workspaceDir = path.join(options.workspace, scenario.id);
    const args = [
      "--import",
      "tsx",
      "scripts/smoke-claude-cli-continuity.ts",
      "--live",
      "--mode",
      scenario.mode,
      "--timeout-ms",
      String(options.timeoutMs),
      "--workspace",
      workspaceDir,
    ];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.codexModel && scenario.id === "codex-context") {
      args.push("--codex-model", options.codexModel);
    }
    return {
      scenario: scenario.id,
      label: scenario.label,
      status: "dry-run",
      ok: false,
      command: commandFor(args),
      workspaceDir,
    };
  });

  if (!options.live) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          live: false,
          note: "Dry run only. Add --live or OPENCLAW_CLI_BACKEND_PARITY_LIVE=1 to call providers.",
          rows: dryRunRows,
        },
        null,
        2,
      ),
    );
    return;
  }

  const rows: ScenarioRow[] = [];
  for (const scenario of options.scenarios) {
    rows.push(await runScenario(scenario, options));
  }
  const ok = rows.every((row) => row.ok);
  console.log(
    JSON.stringify(
      {
        ok,
        live: true,
        workspace: options.workspace,
        rows,
      },
      null,
      2,
    ),
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
