#!/usr/bin/env node
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCliAgent } from "../src/agents/cli-runner.js";
import {
  getClaudeLiveSessionSnapshotsForTest,
  resetClaudeLiveSessionsForTest,
} from "../src/agents/cli-runner/claude-live-session.js";
import type { OpenClawConfig } from "../src/config/config.js";
import {
  closeMcpLoopbackServer,
  ensureMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
} from "../src/gateway/mcp-http.js";

const DEFAULT_TIMEOUT_MS = 180_000;

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

function requireLiveOptIn(): void {
  if (hasFlag("--live") || process.env.OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE === "1") {
    return;
  }
  throw new Error(
    "Refusing to call live Claude CLI without --live or OPENCLAW_CLAUDE_CLI_CONTINUITY_LIVE=1.",
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textFromResult(result: Awaited<ReturnType<typeof runCliAgent>>): string {
  return (
    result.payloads
      ?.map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

function mode():
  | "continuity"
  | "memory"
  | "memory-get"
  | "browser"
  | "browser-tabs"
  | "latency"
  | "inspect" {
  const raw = readFlag("--mode") ?? "continuity";
  if (
    raw === "continuity" ||
    raw === "memory" ||
    raw === "memory-get" ||
    raw === "browser" ||
    raw === "browser-tabs" ||
    raw === "latency" ||
    raw === "inspect"
  ) {
    return raw;
  }
  throw new Error(`Unknown --mode ${raw}`);
}

function sessionIdFromResult(result: Awaited<ReturnType<typeof runCliAgent>>): string {
  return result.meta.agentMeta?.sessionId?.trim() ?? "";
}

function containsToolSubstitution(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("not available") ||
    normalized.includes("no such tool") ||
    normalized.includes("bash tool")
  );
}

function fingerprintHash(value: string | undefined): string | undefined {
  return value ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
}

function createConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    tools: {
      exec: {
        security: "full",
        ask: "off",
      },
    },
  };
}

async function createSmokeContext() {
  const timeoutMs = parsePositiveInt(readFlag("--timeout-ms"), DEFAULT_TIMEOUT_MS);
  const model = readFlag("--model") ?? "sonnet";
  const resumeModel = readFlag("--resume-model") ?? model;
  const workspaceDir =
    readFlag("--workspace") ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-continuity-")));
  await fs.mkdir(workspaceDir, { recursive: true });

  const nonce = readFlag("--nonce") ?? `RUNCLI_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const sessionId = `smoke:claude-cli-continuity:${randomUUID()}`;
  const sessionKey = `agent:claude-cli-continuity:${randomUUID()}`;
  const sessionFile = path.join(workspaceDir, "session.jsonl");
  const config = createConfig(workspaceDir);
  return {
    timeoutMs,
    model,
    resumeModel,
    workspaceDir,
    nonce,
    sessionId,
    sessionKey,
    sessionFile,
    config,
  };
}

async function runAgentTurn(params: {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  workspaceDir: string;
  config: OpenClawConfig;
  model: string;
  timeoutMs: number;
  runId: string;
  prompt: string;
  cliSessionId?: string;
}) {
  const startedAt = process.hrtime.bigint();
  let assistantStartMs: number | undefined;
  let firstVisibleTextMs: number | undefined;
  const result = await runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    provider: "claude-cli",
    model: params.model,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    cliSessionId: params.cliSessionId,
    prompt: params.prompt,
    onAssistantMessageStart: () => {
      assistantStartMs ??= Number(process.hrtime.bigint() - startedAt) / 1e6;
    },
    onPartialReply: ({ text }) => {
      if (text.trim()) {
        firstVisibleTextMs ??= Number(process.hrtime.bigint() - startedAt) / 1e6;
      }
    },
  });
  return {
    result,
    assistantStartMs,
    firstVisibleTextMs,
    totalMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  };
}

async function runContinuitySmoke(): Promise<void> {
  const ctx = await createSmokeContext();

  // Turn 1 must prove the upstream-style OpenClaw loopback MCP path works inside
  // the real claude-cli runner. Use sessions_list because it is harmless,
  // workspace-local, and does not depend on external services or shell access.
  const turn1Run = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-continuity-turn-1",
    prompt: [
      "You must use the directly available mcp__openclaw__sessions_list tool exactly once.",
      "Do not use ToolSearch; this smoke verifies the direct loopback MCP tool path.",
      `Then reply with a short sentence containing RUNCLI_MCP_OK and the exact nonce ${ctx.nonce}.`,
    ].join("\n"),
  });
  const turn1 = turn1Run.result;

  const turn1Text = textFromResult(turn1);
  const firstClaudeSessionId = sessionIdFromResult(turn1);

  if (!firstClaudeSessionId) {
    throw new Error("Turn 1 did not return a Claude CLI session id.");
  }
  if (!turn1Text.includes("RUNCLI_MCP_OK") || !turn1Text.includes(ctx.nonce)) {
    throw new Error(`Turn 1 did not report expected nonce. Text: ${turn1Text}`);
  }
  if (containsToolSubstitution(turn1Text)) {
    throw new Error(
      `Turn 1 substituted another tool instead of loopback MCP sessions_list. Text: ${turn1Text}`,
    );
  }

  // Turn 2 resumes the exact Claude CLI session id from turn 1. The prompt
  // deliberately bans tools so this checks Claude's native session memory, not
  // another filesystem read.
  const turn2Run = await runAgentTurn({
    ...ctx,
    model: ctx.resumeModel,
    runId: "smoke-claude-cli-continuity-turn-2",
    cliSessionId: firstClaudeSessionId,
    prompt: [
      "Do not call any tools.",
      "What exact nonce and tool result happened in the previous turn?",
      `Reply with a short sentence containing CONTINUITY_OK and the exact nonce ${ctx.nonce}.`,
    ].join("\n"),
  });
  const turn2 = turn2Run.result;

  const turn2Text = textFromResult(turn2);
  const secondClaudeSessionId = sessionIdFromResult(turn2);
  if (secondClaudeSessionId !== firstClaudeSessionId) {
    throw new Error(
      `Claude CLI session id changed across resume. First=${firstClaudeSessionId} second=${secondClaudeSessionId}`,
    );
  }
  if (!turn2Text.includes("CONTINUITY_OK") || !turn2Text.includes(ctx.nonce)) {
    throw new Error(`Turn 2 did not recall expected nonce. Text: ${turn2Text}`);
  }
  if (containsToolSubstitution(turn2Text)) {
    throw new Error(
      `Turn 2 recalled a substituted tool instead of loopback MCP sessions_list. Text: ${turn2Text}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "continuity",
        provider: "claude-cli",
        firstModel: ctx.model,
        resumeModel: ctx.resumeModel,
        workspaceDir: ctx.workspaceDir,
        sessionFile: ctx.sessionFile,
        nonce: ctx.nonce,
        claudeSessionId: firstClaudeSessionId,
        turn1Text,
        turn2Text,
      },
      null,
      2,
    ),
  );
}

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  await ensureMcpLoopbackServer();
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("MCP loopback runtime did not start.");
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtime.ownerToken}`,
      "x-session-key": "agent:claude-cli-smoke:direct",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function inspectLoopbackTools(): Promise<void> {
  const listed = await mcpRpc("tools/list");
  const result = listed.body.result as { tools?: Array<{ name: string }> } | undefined;
  const names = (result?.tools ?? []).map((tool) => tool.name).toSorted();
  const memory = names.includes("memory_search")
    ? await mcpRpc("tools/call", {
        name: "memory_search",
        arguments: { query: "claude backend direction smoke", maxResults: 1 },
      })
    : undefined;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "inspect",
        toolCount: names.length,
        toolNames: names,
        hasMemorySearch: names.includes("memory_search"),
        hasMemoryGet: names.includes("memory_get"),
        hasBrowser: names.includes("browser"),
        memorySearchStatus: memory?.status,
        memorySearchBody: memory?.body,
      },
      null,
      2,
    ),
  );
}

async function runMemorySmoke(): Promise<void> {
  const ctx = await createSmokeContext();
  const turn = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-memory",
    prompt: [
      "You must use the directly available mcp__openclaw__memory_search tool exactly once.",
      "Use query: claude backend direction smoke. Set maxResults to 1.",
      "Do not use ToolSearch or web tools.",
      `Then reply with one short sentence containing MEMORY_MCP_OK and the exact nonce ${ctx.nonce}.`,
    ].join("\n"),
  });
  const text = textFromResult(turn.result);
  if (!text.includes("MEMORY_MCP_OK") || !text.includes(ctx.nonce)) {
    throw new Error(`Memory smoke did not report expected nonce. Text: ${text}`);
  }
  if (containsToolSubstitution(text)) {
    throw new Error(`Memory smoke substituted another tool. Text: ${text}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "memory",
        provider: "claude-cli",
        model: ctx.model,
        workspaceDir: ctx.workspaceDir,
        nonce: ctx.nonce,
        claudeSessionId: sessionIdFromResult(turn.result),
        assistantStartMs: turn.assistantStartMs,
        firstVisibleTextMs: turn.firstVisibleTextMs,
        totalMs: turn.totalMs,
        text,
      },
      null,
      2,
    ),
  );
}

async function runMemoryGetSmoke(): Promise<void> {
  const ctx = await createSmokeContext();
  const memoryNeedle = `MEMORY_GET_NEEDLE_${ctx.nonce}`;
  await fs.writeFile(
    path.join(ctx.workspaceDir, "MEMORY.md"),
    [
      "# Claude CLI Memory Get Smoke",
      "",
      "This file is created by the live smoke harness.",
      `Needle: ${memoryNeedle}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  const turn = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-memory-get",
    prompt: [
      "You must use the directly available mcp__openclaw__memory_get tool exactly once.",
      'Call it with path="MEMORY.md", from=1, and lines=5.',
      "Do not use ToolSearch, shell, filesystem, or web tools.",
      `Then reply with one short sentence containing MEMORY_GET_MCP_OK, the exact nonce ${ctx.nonce}, and the exact needle ${memoryNeedle}.`,
    ].join("\n"),
  });
  const text = textFromResult(turn.result);
  if (
    !text.includes("MEMORY_GET_MCP_OK") ||
    !text.includes(ctx.nonce) ||
    !text.includes(memoryNeedle)
  ) {
    throw new Error(`Memory_get smoke did not report expected needle. Text: ${text}`);
  }
  if (containsToolSubstitution(text)) {
    throw new Error(`Memory_get smoke substituted another tool. Text: ${text}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "memory-get",
        provider: "claude-cli",
        model: ctx.model,
        workspaceDir: ctx.workspaceDir,
        nonce: ctx.nonce,
        memoryNeedle,
        claudeSessionId: sessionIdFromResult(turn.result),
        assistantStartMs: turn.assistantStartMs,
        firstVisibleTextMs: turn.firstVisibleTextMs,
        totalMs: turn.totalMs,
        text,
      },
      null,
      2,
    ),
  );
}

async function runBrowserSmoke(): Promise<void> {
  const listed = await mcpRpc("tools/list");
  const result = listed.body.result as { tools?: Array<{ name: string }> } | undefined;
  const names = (result?.tools ?? []).map((tool) => tool.name);
  if (!names.includes("browser")) {
    console.log(
      JSON.stringify({ ok: false, mode: "browser", blocker: "browser tool not listed" }, null, 2),
    );
    return;
  }
  const ctx = await createSmokeContext();
  const turn = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-browser",
    prompt: [
      "You must use the directly available mcp__openclaw__browser tool exactly once.",
      'Call it with action="status", profile="openclaw", and timeoutMs=3000.',
      "Do not use ToolSearch or web tools.",
      `Then reply with one short sentence containing BROWSER_MCP_OK and the exact nonce ${ctx.nonce}.`,
    ].join("\n"),
  });
  const text = textFromResult(turn.result);
  if (!text.includes("BROWSER_MCP_OK") || !text.includes(ctx.nonce)) {
    throw new Error(`Browser smoke did not report expected nonce. Text: ${text}`);
  }
  if (containsToolSubstitution(text)) {
    throw new Error(`Browser smoke substituted another tool. Text: ${text}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "browser",
        provider: "claude-cli",
        model: ctx.model,
        workspaceDir: ctx.workspaceDir,
        nonce: ctx.nonce,
        claudeSessionId: sessionIdFromResult(turn.result),
        assistantStartMs: turn.assistantStartMs,
        firstVisibleTextMs: turn.firstVisibleTextMs,
        totalMs: turn.totalMs,
        text,
      },
      null,
      2,
    ),
  );
}

async function runBrowserTabsSmoke(): Promise<void> {
  const listed = await mcpRpc("tools/list");
  const result = listed.body.result as { tools?: Array<{ name: string }> } | undefined;
  const names = (result?.tools ?? []).map((tool) => tool.name);
  if (!names.includes("browser")) {
    console.log(
      JSON.stringify(
        { ok: false, mode: "browser-tabs", blocker: "browser tool not listed" },
        null,
        2,
      ),
    );
    return;
  }
  const ctx = await createSmokeContext();
  const turn = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-browser-tabs",
    prompt: [
      "You must use the directly available mcp__openclaw__browser tool exactly once.",
      'Call it with action="tabs", profile="openclaw", and timeoutMs=3000.',
      "Do not use ToolSearch or web tools.",
      `Then reply with one short sentence containing BROWSER_TABS_MCP_OK and the exact nonce ${ctx.nonce}.`,
    ].join("\n"),
  });
  const text = textFromResult(turn.result);
  if (!text.includes("BROWSER_TABS_MCP_OK") || !text.includes(ctx.nonce)) {
    throw new Error(`Browser tabs smoke did not report expected nonce. Text: ${text}`);
  }
  if (containsToolSubstitution(text)) {
    throw new Error(`Browser tabs smoke substituted another tool. Text: ${text}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "browser-tabs",
        provider: "claude-cli",
        model: ctx.model,
        workspaceDir: ctx.workspaceDir,
        nonce: ctx.nonce,
        claudeSessionId: sessionIdFromResult(turn.result),
        assistantStartMs: turn.assistantStartMs,
        firstVisibleTextMs: turn.firstVisibleTextMs,
        totalMs: turn.totalMs,
        text,
      },
      null,
      2,
    ),
  );
}

async function runWarmLatencySmoke(): Promise<void> {
  const ctx = await createSmokeContext();
  const turn1 = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    runId: "smoke-claude-cli-latency-turn-1",
    prompt: `Reply with exactly one short sentence containing WARM_LATENCY_1 and ${ctx.nonce}.`,
  });
  const sessionAfterTurn1 = getClaudeLiveSessionSnapshotsForTest();
  const claudeSessionId = sessionIdFromResult(turn1.result);
  const turn2 = await runAgentTurn({
    ...ctx,
    model: ctx.model,
    cliSessionId: claudeSessionId,
    runId: "smoke-claude-cli-latency-turn-2",
    prompt: `Reply with exactly one short sentence containing WARM_LATENCY_2 and ${ctx.nonce}.`,
  });
  const sessionAfterTurn2 = getClaudeLiveSessionSnapshotsForTest();
  const text1 = textFromResult(turn1.result);
  const text2 = textFromResult(turn2.result);
  if (!text1.includes("WARM_LATENCY_1") || !text1.includes(ctx.nonce)) {
    throw new Error(`Latency turn 1 did not report expected nonce. Text: ${text1}`);
  }
  if (!text2.includes("WARM_LATENCY_2") || !text2.includes(ctx.nonce)) {
    throw new Error(`Latency turn 2 did not report expected nonce. Text: ${text2}`);
  }
  const firstLive = sessionAfterTurn1[0];
  const secondLive = sessionAfterTurn2[0];
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "latency",
        provider: "claude-cli",
        model: ctx.model,
        workspaceDir: ctx.workspaceDir,
        nonce: ctx.nonce,
        claudeSessionId,
        secondClaudeSessionId: sessionIdFromResult(turn2.result),
        sameClaudeSessionId: claudeSessionId === sessionIdFromResult(turn2.result),
        liveProcess: {
          firstPid: firstLive?.pid,
          secondPid: secondLive?.pid,
          samePid: Boolean(firstLive?.pid && firstLive.pid === secondLive?.pid),
          firstStartedAtMs: firstLive?.startedAtMs,
          secondStartedAtMs: secondLive?.startedAtMs,
          sameStartedAtMs: Boolean(
            firstLive?.startedAtMs && firstLive.startedAtMs === secondLive?.startedAtMs,
          ),
          sameFingerprint: Boolean(
            firstLive?.fingerprint && firstLive.fingerprint === secondLive?.fingerprint,
          ),
          firstFingerprintHash: fingerprintHash(firstLive?.fingerprint),
          secondFingerprintHash: fingerprintHash(secondLive?.fingerprint),
        },
        turn1: {
          assistantStartMs: turn1.assistantStartMs,
          firstVisibleTextMs: turn1.firstVisibleTextMs,
          totalMs: turn1.totalMs,
          durationMs: turn1.result.meta.durationMs,
          text: text1,
        },
        turn2: {
          assistantStartMs: turn2.assistantStartMs,
          firstVisibleTextMs: turn2.firstVisibleTextMs,
          totalMs: turn2.totalMs,
          durationMs: turn2.result.meta.durationMs,
          text: text2,
        },
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  requireLiveOptIn();
  const selectedMode = mode();
  if (selectedMode === "inspect") {
    await inspectLoopbackTools();
    return;
  }
  if (selectedMode === "memory") {
    await runMemorySmoke();
    return;
  }
  if (selectedMode === "memory-get") {
    await runMemoryGetSmoke();
    return;
  }
  if (selectedMode === "browser") {
    await runBrowserSmoke();
    return;
  }
  if (selectedMode === "browser-tabs") {
    await runBrowserTabsSmoke();
    return;
  }
  if (selectedMode === "latency") {
    await runWarmLatencySmoke();
    return;
  }
  await runContinuitySmoke();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    resetClaudeLiveSessionsForTest();
    void closeMcpLoopbackServer().finally(() => process.exit(process.exitCode ?? 0));
  });
