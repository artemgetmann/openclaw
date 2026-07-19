import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { typedCases } from "../test-utils/typed-cases.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import {
  buildAgentSystemPrompt,
  buildPendingRestartConfirmationPromptHint,
  buildRuntimeLine,
} from "./system-prompt.js";
import { DURABLE_PLAN_FILE_POLICY_PROMPT } from "./tools/durable-plan-file-policy.js";

describe("buildAgentSystemPrompt", () => {
  it("formats owner section for plain, hash, and missing owner lists", () => {
    const cases = typedCases<{
      name: string;
      params: Parameters<typeof buildAgentSystemPrompt>[0];
      expectAuthorizedSection: boolean;
      contains: string[];
      notContains: string[];
      hashMatch?: RegExp;
    }>([
      {
        name: "plain owner numbers",
        params: {
          workspaceDir: "/tmp/openclaw",
          ownerNumbers: ["+123", " +456 ", ""],
        },
        expectAuthorizedSection: true,
        contains: [
          "Authorized senders: +123, +456. These senders are allowlisted; do not assume they are the owner.",
        ],
        notContains: [],
      },
      {
        name: "hashed owner numbers",
        params: {
          workspaceDir: "/tmp/openclaw",
          ownerNumbers: ["+123", "+456", ""],
          ownerDisplay: "hash",
        },
        expectAuthorizedSection: true,
        contains: ["Authorized senders:"],
        notContains: ["+123", "+456"],
        hashMatch: /[a-f0-9]{12}/,
      },
      {
        name: "missing owners",
        params: {
          workspaceDir: "/tmp/openclaw",
        },
        expectAuthorizedSection: false,
        contains: [],
        notContains: ["## Authorized Senders", "Authorized senders:"],
      },
    ]);

    for (const testCase of cases) {
      const prompt = buildAgentSystemPrompt(testCase.params);
      if (testCase.expectAuthorizedSection) {
        expect(prompt, testCase.name).toContain("## Authorized Senders");
      } else {
        expect(prompt, testCase.name).not.toContain("## Authorized Senders");
      }
      for (const value of testCase.contains) {
        expect(prompt, `${testCase.name}:${value}`).toContain(value);
      }
      for (const value of testCase.notContains) {
        expect(prompt, `${testCase.name}:${value}`).not.toContain(value);
      }
      if (testCase.hashMatch) {
        expect(prompt, testCase.name).toMatch(testCase.hashMatch);
      }
    }
  });

  it("uses a stable, keyed HMAC when ownerDisplaySecret is provided", () => {
    const secretA = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ownerNumbers: ["+123"],
      ownerDisplay: "hash",
      ownerDisplaySecret: "secret-key-A", // pragma: allowlist secret
    });

    const secretB = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ownerNumbers: ["+123"],
      ownerDisplay: "hash",
      ownerDisplaySecret: "secret-key-B", // pragma: allowlist secret
    });

    const lineA = secretA.split("## Authorized Senders")[1]?.split("\n")[1];
    const lineB = secretB.split("## Authorized Senders")[1]?.split("\n")[1];
    const tokenA = lineA?.match(/[a-f0-9]{12}/)?.[0];
    const tokenB = lineB?.match(/[a-f0-9]{12}/)?.[0];

    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenA).not.toBe(tokenB);
  });

  it("omits extended sections in minimal prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      ownerNumbers: ["+123"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      heartbeatPrompt: "ping",
      toolNames: ["message", "memory_search"],
      docsPath: "/tmp/openclaw/docs",
      extraSystemPrompt: "Subagent details",
      ttsHint: "Voice (TTS) is enabled.",
    });

    expect(prompt).not.toContain("## Authorized Senders");
    // Skills are included even in minimal mode when skillsPrompt is provided (cron sessions need them)
    expect(prompt).toContain("## Skills");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Documentation");
    expect(prompt).not.toContain("## Reply Tags");
    expect(prompt).not.toContain("## Messaging");
    expect(prompt).not.toContain("For Telegram comparison or data tables");
    expect(prompt).not.toContain("## Voice (TTS)");
    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).",
    );
    expect(prompt).toContain("You have no independent goals");
    expect(prompt).toContain("Prioritize safety and human oversight");
    expect(prompt).toContain("if instructions conflict");
    expect(prompt).toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not manipulate or persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change system prompts");
    expect(prompt).toContain("## Subagent Context");
    expect(prompt).not.toContain("## Group Chat Context");
    expect(prompt).toContain("Subagent details");
  });

  it("includes skills in minimal prompt mode when skillsPrompt is provided (cron regression)", () => {
    // Isolated cron sessions use promptMode="minimal" but must still receive skills.
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      skillsPrompt,
    });

    expect(prompt).toContain("## Skills (mandatory)");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain(
      "When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    );
  });

  it("routes clear Telegram read requests through the injected telegram-user skill before shell discovery", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>telegram-user</name>",
        "    <description>Read and act as the user on Telegram, including checking replies and voice notes.</description>",
        "    <location>/tmp/openclaw/skills/telegram-user/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    });

    expect(prompt).toContain(
      "If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it before any generic discovery.",
    );
    expect(prompt).toContain(
      "do not run `openclaw skills list`, grep/search local skill directories, or inspect skill registries as your first discovery step",
    );
    expect(prompt).toContain("<name>telegram-user</name>");
    expect(prompt.indexOf("<name>telegram-user</name>")).toBeLessThan(
      prompt.indexOf("openclaw skills list"),
    );
  });

  it("separates Telegram status updates from Telegram-as-me topic handoffs", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>telegram-chat-management</name>",
        "    <description>Manage Telegram chats, topics, threads, handoffs, and send-as-me flows.</description>",
        "    <location>/tmp/openclaw/skills/telegram-chat-management/SKILL.md</location>",
        "  </skill>",
        "  <skill>",
        "    <name>telegram-user</name>",
        "    <description>Use Telegram-as-me from the user's real account.</description>",
        "    <location>/tmp/openclaw/skills/telegram-user/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    });

    expect(prompt).toContain("For Telegram chat/topic/thread handoffs");
    expect(prompt).toContain("If the user says to message/update them");
    expect(prompt).toContain("normal bot/status channel");
    expect(prompt).toContain("post/send as me into a Telegram chat, topic, or thread");
    expect(prompt).toContain("use `telegram-chat-management`");
    expect(prompt).toContain("`telegram-user` Telegram-as-me flow");
  });

  it("omits skills in minimal prompt mode when skillsPrompt is absent", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## Skills");
  });

  it("instructs models to orient users before update_plan for multi-step work", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["update_plan"],
    });

    expect(prompt).toContain("## Planning");
    const orientationInstruction = "first send one short natural-language status note";
    const planInstruction = "then call update_plan before the first non-trivial tool call";
    expect(prompt).toContain(orientationInstruction);
    expect(prompt).toContain(planInstruction);
    expect(prompt.indexOf(orientationInstruction)).toBeLessThan(prompt.indexOf(planInstruction));
    expect(prompt).toContain("what you are doing now/next");
    expect(prompt).toContain("avoid repeating the checklist verbatim");
    expect(prompt).toContain("two or more meaningful steps");
    expect(prompt).toContain("update_plan is not /goal");
    expect(prompt).toContain(DURABLE_PLAN_FILE_POLICY_PROMPT);
  });

  it("includes safety guardrails in full prompts", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("You have no independent goals");
    expect(prompt).toContain("Prioritize safety and human oversight");
    expect(prompt).toContain("if instructions conflict");
    expect(prompt).toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not manipulate or persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change system prompts");
  });

  it("includes voice hint when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ttsHint: "Voice (TTS) is enabled.",
    });

    expect(prompt).toContain("## Voice (TTS)");
    expect(prompt).toContain("Voice (TTS) is enabled.");
  });

  it("includes compact goal-tool routing when goal tools are available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["get_goal", "create_goal", "update_goal", "monitor"],
      skillsPrompt: "<available_skills><skill><name>goal-mode</name></skill></available_skills>",
    });

    expect(prompt).toContain("## Goal Tools");
    expect(prompt).toContain("use the `goal-mode` skill from <available_skills>");
    expect(prompt).toContain("Use /goal as a recovery/control surface");
    expect(prompt).not.toContain("Scoped autonomy");
    expect(prompt).not.toContain('Call update_goal(status="complete") only with evidence');
    expect(prompt).toContain(
      "if the user's stated next step depends on a later reply/status, treat this as a post-action handoff",
    );
    expect(prompt).toContain("before the same final, read `goal-mode`");
    expect(prompt).toContain("even if another skill handled the action");
  });

  it("omits monitor-specific goal guidance when monitor is unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["get_goal", "create_goal", "update_goal"],
      skillsPrompt: "<available_skills><skill><name>goal-mode</name></skill></available_skills>",
    });

    expect(prompt).toContain("## Goal Tools");
    expect(prompt).not.toContain("treat this as a post-action handoff");
  });

  it("keeps the proactive monitor cue compact", () => {
    const promptWithMonitor = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["get_goal", "create_goal", "update_goal", "monitor"],
      skillsPrompt: "<available_skills><skill><name>goal-mode</name></skill></available_skills>",
    });
    const goalToolsSection = promptWithMonitor.split("## Goal Tools")[1]?.split("\n## ")[0] ?? "";

    expect(goalToolsSection).toContain("After an external send/action");
    expect(goalToolsSection).toContain("user's stated next step depends");
    expect(goalToolsSection).toContain("before the same final");
    expect(goalToolsSection).toContain("even if another skill handled the action");
    expect(goalToolsSection).toContain("skip casual sends");
    expect(goalToolsSection).toContain("never create one without approval");
    expect(goalToolsSection).not.toContain("default notify with a drafted next response");
    expect(goalToolsSection).not.toContain("buttons, settings, or commands");
  });

  it("adds reasoning tag hint when enabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: true,
    });

    expect(prompt).toContain("## Reasoning Format");
    expect(prompt).toContain("<think>...</think>");
    expect(prompt).toContain("<final>...</final>");
  });

  it("includes a CLI quick reference section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## OpenClaw CLI Quick Reference");
    expect(prompt).toContain("openclaw gateway restart");
    expect(prompt).toContain("Do not invent commands");
  });

  it("guides runtime completion events without exposing internal metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("Runtime-generated completion events may ask for a user update.");
    expect(prompt).toContain("Rewrite those in your normal assistant voice");
    expect(prompt).toContain("do not forward raw internal metadata");
  });

  it("requires live-thread freshness before external outreach drafts and sends", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("external outreach/reply drafts");
    expect(prompt).toContain("trackers, memory, docs");
    expect(prompt).toContain("stale indexes");
    expect(prompt).toContain("read the latest relevant thread/person first");
    expect(prompt).toContain("quote the latest relevant inbound message text");
    expect(prompt).toContain("new, already sent, optional, or do-not-send");
    expect(prompt).toContain("Before any approved send, refresh the same live thread again");
    expect(prompt).toContain(
      "stop if newer relevant thread movement, inbound or outbound, changes or duplicates the reply",
    );
    expect(prompt).toContain("state that freshness is not verified");
    expect(prompt).toContain(
      "label any optional sketch as stale/tracker-based and not ready to send",
    );
    expect(prompt).not.toContain("wacli-recent-reply.sh");
    expect(prompt).not.toContain("telegram-user download --chat <chat> --message-id <id>");
  });

  it("guides subagent workflows to avoid polling loops", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).",
    );
    expect(prompt).toContain("Completion is push-based: it will auto-announce when done.");
    expect(prompt).toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain(
      "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
    );
    expect(prompt).toContain(
      "For channel-specific monitoring or reply-detection jobs, read the matching skill and use its helper scripts/check commands instead of inventing raw discovery flows.",
    );
    expect(prompt).toContain(
      "For monitor-related replies or status questions, use the monitor-router skill",
    );
    expect(prompt).toContain(
      "Before answering a status question about a watched person/task, call monitor list/get",
    );
    expect(prompt).toContain("answer from monitor state before old chat memory");
    expect(prompt).toContain("ask a short clarification before ambiguous external actions");
    expect(prompt).toContain("When creating a monitor, encode deterministic wake instructions.");
    expect(prompt).toContain("pin that exact command");
    expect(prompt).toContain("create the tiny check script during monitor setup");
    expect(prompt).toContain(
      "For WhatsApp or Telegram-as-me jobs, route through the matching skill",
    );
    expect(prompt).toContain("`wacli` or `telegram-user`");
    expect(prompt).toContain("For Telegram chat/topic/thread handoffs");
    expect(prompt).toContain("use `telegram-chat-management`");
    expect(prompt).toContain(
      "keep those channel-specific procedures there instead of copying command playbooks into the prompt",
    );
    expect(prompt).toContain(
      "For macOS computer-use, GUI-operation, or GUI-proof requests, prefer the `jarvis-computer-use` skill",
    );
    expect(prompt).toContain("use the `screen-record` skill and `openclaw screen record`");
    expect(prompt).toContain(
      "Before sending or claiming any user-facing screenshot, screen recording, or other media proof",
    );
    expect(prompt).toContain("For a standalone local audio file the user wants transcribed");
    expect(prompt).toContain("media transcribe --file <path> --json");
    expect(prompt).toContain(
      "channel-specific voice-note retrieval belongs in the matching channel skill",
    );
    expect(prompt).not.toContain("wacli-recent-reply.sh");
    expect(prompt).not.toContain("telegram-user download --chat <chat> --message-id <id>");
    expect(prompt).not.toContain("do not inspect Telethon internals");
  });

  it("formats Telegram data tables as native rich tables in full prompts only", () => {
    const fullPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });
    const minimalPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
    });

    expect(fullPrompt).toContain("For Telegram comparison or data tables");
    expect(fullPrompt).toContain("standard unfenced Markdown pipe table");
    expect(fullPrompt).toContain("one header row and one delimiter row");
    expect(fullPrompt).toContain("Never wrap data tables in code fences");
    expect(fullPrompt).toContain("literal copy text instead of native rich tables");
    expect(minimalPrompt).not.toContain("For Telegram comparison or data tables");
  });

  it("uses consumer terminology for reminders and explicit monitors", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["cron"],
    });

    expect(prompt).toContain("use reminder or scheduled task for one-time/generic scheduling");
    expect(prompt).toContain(
      "use monitor or monitoring for a watched inbox, thread, person, or condition",
    );
    expect(prompt).toContain("never call a consumer-facing monitor a cron job");
    expect(prompt).toContain(
      "a watched inbox, thread, person, or condition until something changes",
    );
    expect(prompt).toContain("cadence, stop condition, and expiry");
    expect(prompt).toContain("use the relevant skill/helper script for detection");
    expect(prompt).toContain("pin that exact command or a tiny wrapper script");
    expect(prompt).toContain("create the tiny check script at authoring time");
    expect(prompt).toContain("use heartbeat only for optional broad low-frequency awareness");
  });

  it("describes heartbeat as ambient awareness rather than the default monitor engine", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      heartbeatPrompt: HEARTBEAT_PROMPT,
    });

    expect(prompt).toContain(
      "Heartbeat is for optional broad ambient awareness and periodic sweeps across things like inbox, calendar, notifications, or project health.",
    );
    expect(prompt).toContain(
      "It is not the default engine for ad hoc scoped monitors or per-inbox/per-thread/per-person watches.",
    );
    expect(prompt).toContain(
      "If the user explicitly wants recurring monitoring of a specific inbox, thread, person, or condition until something happens, prefer a monitor/monitoring flow",
    );
    expect(prompt).toContain(
      "Heartbeat can still cover broad periodic checks when the user wants them, including 30-minute sweeps",
    );
    expect(prompt).toContain(
      "Keep heartbeat conservative and approval-oriented. If a heartbeat suggests deeper follow-up work or a new recurring monitor, ask before creating that scope.",
    );
  });

  it("lists available tools when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain("Tool availability (filtered by policy):");
    expect(prompt).toContain("sessions_list");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("sessions_send");
  });

  it("describes image_generate when the tool is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["image_generate", "image"],
    });

    expect(prompt).toContain(
      "- image_generate: Generate new images or edit reference images with the configured image-generation model",
    );
    expect(prompt).toContain("- image: Analyze an image with the configured image model");
  });

  it("documents ACP sessions_spawn agent targeting requirements", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
    });

    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain(
      'runtime="acp" requires `agentId` unless `acp.defaultAgent` is configured',
    );
    expect(prompt).toContain("not agents_list");
  });

  it("guides harness requests to one-shot ACP worker spawns by default", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
    });

    expect(prompt).toContain(
      'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent',
    );
    expect(prompt).toContain('`runtime: "acp"`, `mode: "run"`, and `streamTo: "parent"`');
    expect(prompt).toContain(
      "Default ACP harness requests are one-shot worker calls streamed back to the parent session",
    );
    expect(prompt).toContain(
      "do not route ACP harness requests through `subagents`/`agents_list` or local PTY exec flows",
    );
    expect(prompt).toContain(
      'For explicit ACP harness thread binding, tell the user you are binding the conversation, then call `sessions_spawn` with `runtime: "acp"`, `thread: true`, and `mode: "session"`',
    );
  });

  it("omits ACP harness guidance when ACP is disabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      acpEnabled: false,
    });

    expect(prompt).not.toContain(
      'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent',
    );
    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("not ACP harness ids");
    expect(prompt).toContain("- sessions_spawn: Spawn an isolated sub-agent session");
    expect(prompt).toContain("- agents_list: List OpenClaw agent ids allowed for sessions_spawn");
  });

  it("omits ACP harness spawn guidance for sandboxed sessions and shows ACP block note", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      sandboxInfo: {
        enabled: true,
      },
    });

    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("ACP harness ids follow acp.allowedAgents");
    expect(prompt).not.toContain(
      'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent',
    );
    expect(prompt).not.toContain(
      "Default ACP harness requests are one-shot worker calls streamed back to the parent session",
    );
    expect(prompt).toContain("ACP harness spawns are blocked from sandboxed sessions");
    expect(prompt).toContain('`runtime: "acp"`');
    expect(prompt).toContain('Use `runtime: "subagent"` instead.');
  });

  it("preserves tool casing in the prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["Read", "Exec", "process"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("- Read: Read file contents");
    expect(prompt).toContain("- Exec: Run shell commands");
    expect(prompt).toContain(
      "- If exactly one skill clearly applies: read its SKILL.md at <location> with `Read`, then follow it before any generic discovery.",
    );
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain(
      "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    );
  });

  it("includes docs guidance when docsPath is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("## Documentation");
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain(
      "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    );
  });

  it("includes workspace notes when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      workspaceNotes: ["Reminder: commit your changes in this workspace after edits."],
    });

    expect(prompt).toContain("Reminder: commit your changes in this workspace after edits.");
  });

  it("shows timezone section for 12h, 24h, and timezone-only modes", () => {
    const cases = [
      {
        name: "12-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 — 3:26 PM",
          userTimeFormat: "12" as const,
        },
      },
      {
        name: "24-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 — 15:26",
          userTimeFormat: "24" as const,
        },
      },
      {
        name: "timezone-only",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTimeFormat: "24" as const,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const prompt = buildAgentSystemPrompt(testCase.params);
      expect(prompt, testCase.name).toContain("## Current Date & Time");
      expect(prompt, testCase.name).toContain("Time zone: America/Chicago");
    }
  });

  it("hints to use session_status for current date/time", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
    });

    expect(prompt).toContain("session_status");
    expect(prompt).toContain("current date");
  });

  it("requires temporal grounding when working from external messages", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      userTimezone: "Asia/Makassar",
    });

    expect(prompt).toContain("## Temporal Grounding");
    expect(prompt).toContain("treat each source timestamp as semantic context");
    expect(prompt).toContain("get it from session_status");
    expect(prompt).toContain(
      "Resolve today, tomorrow, yesterday, and weekdays relative to when the source message was sent",
    );
    expect(prompt).toContain(
      "Use the sender's timezone when known; otherwise use the user's timezone.",
    );
    expect(prompt).toContain("flag material ambiguity instead of guessing");
    expect(prompt).toContain("never present stale relative language as current");
    expect(prompt).toContain("include its absolute source date");
    expect(prompt).toContain("say timing is unknown; do not invent it");
  });

  it("keeps temporal grounding compatible with minimal subagent tool policies", () => {
    const promptWithSessionStatus = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      toolNames: ["session_status"],
      userTimezone: "Asia/Makassar",
    });
    const promptWithoutSessionStatus = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      toolNames: ["read"],
      userTimezone: "Asia/Makassar",
    });

    expect(promptWithSessionStatus).toContain("## Temporal Grounding");
    expect(promptWithSessionStatus).toContain("get it from session_status");
    expect(promptWithSessionStatus).toContain("run session_status");
    expect(promptWithoutSessionStatus).toContain("## Temporal Grounding");
    expect(promptWithoutSessionStatus).toContain("recency cannot be verified; do not guess");
    expect(promptWithoutSessionStatus).not.toContain("session_status");
  });

  // The system prompt intentionally does NOT include the current date/time.
  // Only the timezone is included, to keep the prompt stable for caching.
  // See: https://github.com/moltbot/moltbot/commit/66eec295b894bce8333886cfbca3b960c57c4946
  // Agents should use session_status or message timestamps to determine the date/time.
  // Related: https://github.com/moltbot/moltbot/issues/1897
  //          https://github.com/moltbot/moltbot/issues/3658
  it("does NOT include a date or time in the system prompt (cache stability)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
      userTime: "Monday, January 5th, 2026 — 3:26 PM",
      userTimeFormat: "12",
    });

    // The prompt should contain the timezone but NOT the formatted date/time string.
    // This is intentional for prompt cache stability — the date/time was removed in
    // commit 66eec295b. If you're here because you want to add it back, please see
    // https://github.com/moltbot/moltbot/issues/3658 for the preferred approach:
    // gateway-level timestamp injection into messages, not the system prompt.
    expect(prompt).toContain("Time zone: America/Chicago");
    expect(prompt).not.toContain("Monday, January 5th, 2026");
    expect(prompt).not.toContain("3:26 PM");
    expect(prompt).not.toContain("15:26");
  });

  it("includes model alias guidance when aliases are provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      modelAliasLines: [
        "- Opus: anthropic/claude-opus-4-5",
        "- Sonnet: anthropic/claude-sonnet-4-5",
      ],
    });

    expect(prompt).toContain("## Model Aliases");
    expect(prompt).toContain("Prefer aliases when specifying model overrides");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-5");
  });

  it("adds ClaudeBot self-update guidance when gateway tool is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["gateway", "exec"],
    });

    expect(prompt).toContain("## OpenClaw Self-Update");
    expect(prompt).toContain("config.schema.lookup");
    expect(prompt).toContain("config.apply");
    expect(prompt).toContain("config.patch");
    expect(prompt).toContain("update.run");
    expect(prompt).not.toContain("Use config.schema to");
    expect(prompt).not.toContain("config.schema, config.apply");
  });

  it("includes skills guidance when skills prompt is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(
      "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it before any generic discovery.",
    );
  });

  it("appends available skills when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>demo</name>");
  });

  it("omits skills section when no skills prompt is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("<available_skills>");
  });

  it("renders project context files when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: "AGENTS.md", content: "Alpha" },
        { path: "IDENTITY.md", content: "Bravo" },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("Bravo");
  });

  it("ignores context files with missing or blank paths", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: undefined as unknown as string, content: "Missing path" },
        { path: "   ", content: "Blank path" },
        { path: "AGENTS.md", content: "Alpha" },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).not.toContain("Missing path");
    expect(prompt).not.toContain("Blank path");
  });

  it("adds SOUL guidance when a soul file is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: "./SOUL.md", content: "Persona" },
        { path: "dir\\SOUL.md", content: "Persona Windows" },
      ],
    });

    expect(prompt).toContain(
      "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
    );
  });

  it("renders bootstrap truncation warning even when no context files are injected", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      bootstrapTruncationWarningLines: ["AGENTS.md: 200 raw -> 0 injected"],
      contextFiles: [],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("⚠ Bootstrap truncation warning:");
    expect(prompt).toContain("- AGENTS.md: 200 raw -> 0 injected");
  });

  it("summarizes the message tool when available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
    });

    expect(prompt).toContain("message: Send messages and channel actions");
    expect(prompt).toContain("### message tool");
    expect(prompt).toContain(`respond with ONLY: ${SILENT_REPLY_TOKEN}`);
  });

  it("includes inline button style guidance when runtime supports inline buttons", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("buttons=[[{text,callback_data,style?}]]");
    expect(prompt).toContain("`style` can be `primary`, `success`, or `danger`");
  });

  it("includes runtime provider capabilities when present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("channel=telegram");
    expect(prompt).toContain("capabilities=inlineButtons");
  });

  it("includes agent id in runtime when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "work",
        host: "host",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
      },
    });

    expect(prompt).toContain("agent=work");
  });

  it("includes reasoning visibility hint", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningLevel: "off",
    });

    expect(prompt).toContain("Reasoning: off");
    expect(prompt).toContain("/reasoning");
    expect(prompt).toContain("/status shows Reasoning");
  });

  it("builds runtime line with agent and channel details", () => {
    const line = buildRuntimeLine(
      {
        agentId: "work",
        host: "host",
        repoRoot: "/repo",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
        defaultModel: "anthropic/claude-opus-4-5",
      },
      "telegram",
      ["inlineButtons"],
      "low",
    );

    expect(line).toContain("agent=work");
    expect(line).toContain("host=host");
    expect(line).toContain("repo=/repo");
    expect(line).toContain("os=macOS (arm64)");
    expect(line).toContain("node=v20");
    expect(line).toContain("model=anthropic/claude");
    expect(line).toContain("default_model=anthropic/claude-opus-4-5");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("capabilities=inlineButtons");
    expect(line).toContain("thinking=low");
  });

  it("describes sandboxed runtime and elevated when allowed", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      sandboxInfo: {
        enabled: true,
        workspaceDir: "/tmp/sandbox",
        containerWorkspaceDir: "/workspace",
        workspaceAccess: "ro",
        agentWorkspaceMount: "/agent",
        elevated: { allowed: true, defaultLevel: "on" },
      },
    });

    expect(prompt).toContain("Your working directory is: /workspace");
    expect(prompt).toContain(
      "For read/write/edit/apply_patch, file paths resolve against host workspace: /tmp/openclaw. For bash/exec commands, use sandbox container paths under /workspace (or relative paths from that workdir), not host paths.",
    );
    expect(prompt).toContain("Sandbox container workdir: /workspace");
    expect(prompt).toContain(
      "Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): /tmp/sandbox",
    );
    expect(prompt).toContain("You are running in a sandboxed runtime");
    expect(prompt).toContain("Sub-agents stay sandboxed");
    expect(prompt).toContain("User can toggle with /elevated on|off|ask|full.");
    expect(prompt).toContain("Current elevated level: on");
  });

  it("includes reaction guidance when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reactionGuidance: {
        level: "minimal",
        channel: "Telegram",
      },
    });

    expect(prompt).toContain("## Reactions");
    expect(prompt).toContain("Reactions are enabled for Telegram in MINIMAL mode.");
  });

  it("requires arming session-scoped restart confirmation before asking the user", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["gateway"],
    });
    const armInstruction =
      "when this session does not already have a pending restart confirmation, you MUST first call the gateway tool with action `restart.request_confirmation`";
    const askInstruction =
      'Only after that tool call succeeds, ask exactly: "This will interrupt other tasks that you have running in other chats. Restart now?"';

    expect(prompt.indexOf(armInstruction)).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(askInstruction)).toBeGreaterThan(prompt.indexOf(armInstruction));
    expect(prompt).toContain(
      "Never ask the restart confirmation question before the gateway tool successfully records the pending confirmation.",
    );
    expect(prompt).toContain(
      "If a pending restart confirmation already exists, do not call `restart.request_confirmation` again",
    );
    expect(prompt).toContain("Only proceed on a later user turn");
    expect(prompt).toContain("`/restart` remains the escape hatch");
  });
});

describe("buildPendingRestartConfirmationPromptHint", () => {
  it("tells the model to require a clear confirmation on the current user turn", () => {
    const hint = buildPendingRestartConfirmationPromptHint();

    expect(hint).toContain("A pending restart confirmation exists for this session.");
    expect(hint).toContain(
      "Do not call `restart.request_confirmation` again while this pending confirmation exists.",
    );
    expect(hint).toContain("current user turn clearly confirms");
    expect(hint).toContain("Do not treat your own prior message");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("renders depth-1 orchestrator guidance, labels, and recovery notes", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain(
      "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
    );
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain('runtime: "acp"');
    expect(prompt).toContain("For ACP harness sessions (codex/claudecode/gemini)");
    expect(prompt).toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("Do not ask users to run slash commands or CLI");
    expect(prompt).toContain("Do not use `exec` (`openclaw ...`, `acpx ...`)");
    expect(prompt).toContain("Use `subagents` only for OpenClaw subagents");
    expect(prompt).toContain(
      'Default ACP harness work uses one-shot `mode: "run"` calls with `streamTo: "parent"`',
    );
    expect(prompt).toContain("only for explicit bind/focus requests");
    expect(prompt).toContain(
      "After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool.",
    );
    expect(prompt).toContain(
      "Track expected child session keys and only send your final answer after completion events for ALL expected children arrive.",
    );
    expect(prompt).toContain(
      "If a child completion event arrives AFTER you already sent your final answer, reply ONLY with NO_REPLY.",
    );
    expect(prompt).toContain("Avoid polling loops");
    expect(prompt).toContain("spawned by the main agent");
    expect(prompt).toContain("reported to the main agent");
    expect(prompt).toContain("[compacted: tool output removed to free context]");
    expect(prompt).toContain("[truncated: output exceeded context limit]");
    expect(prompt).toContain("offset/limit");
    expect(prompt).toContain("instead of full-file `cat`");
  });

  it("omits ACP spawning guidance when ACP is disabled", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: false,
    });

    expect(prompt).not.toContain('runtime: "acp"');
    expect(prompt).not.toContain("For ACP harness sessions (codex/claudecode/gemini)");
    expect(prompt).not.toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("You CAN spawn your own sub-agents");
  });

  it("renders depth-2 leaf guidance with parent orchestrator labels", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc:subagent:def",
      task: "leaf task",
      childDepth: 2,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain("leaf worker");
    expect(prompt).toContain("CANNOT spawn further sub-agents");
    expect(prompt).toContain("spawned by the parent orchestrator");
    expect(prompt).toContain("reported to the parent orchestrator");
  });

  it("omits spawning guidance for depth-1 leaf agents", () => {
    const leafCases = [
      {
        name: "explicit maxSpawnDepth 1",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "research task",
          childDepth: 1,
          maxSpawnDepth: 1,
        },
        expectMainAgentLabel: false,
      },
      {
        name: "implicit default depth/maxSpawnDepth",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "basic task",
        },
        expectMainAgentLabel: true,
      },
    ] as const;

    for (const testCase of leafCases) {
      const prompt = buildSubagentSystemPrompt(testCase.input);
      expect(prompt, testCase.name).not.toContain("## Sub-Agent Spawning");
      expect(prompt, testCase.name).not.toContain("You CAN spawn");
      if (testCase.expectMainAgentLabel) {
        expect(prompt, testCase.name).toContain("spawned by the main agent");
      }
    }
  });
});
