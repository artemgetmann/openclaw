import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionMemoryScope,
  resolveStoredSessionMemoryScope,
  resolveStorePath,
  type SessionMemoryScope,
} from "../config/sessions.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    sanitized.push({ ...file, path: pathValue });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  const runKind = params.runKind ?? "default";
  if (contextMode !== "lightweight") {
    return params.files;
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === "HEARTBEAT.md");
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

function applyMemoryScopeFilter(params: {
  files: WorkspaceBootstrapFile[];
  memoryScope: SessionMemoryScope;
}): WorkspaceBootstrapFile[] {
  if (params.memoryScope === "personal") {
    return params.files;
  }
  return params.files.filter(
    (file) =>
      file.name !== "MEMORY.md" && file.name !== "memory.md" && !file.name.startsWith("memory/"),
  );
}

function resolveBootstrapMemoryScope(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): SessionMemoryScope {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return "personal";
  }

  // Session-scoped trust beats naming heuristics. The session store is the one
  // place where reply flows, CLI, and reruns can agree on the current memory lane.
  try {
    const storePath = resolveStorePath(params.config?.session?.store, {
      agentId: params.agentId,
    });
    const entry = loadSessionStore(storePath)[sessionKey];
    if (entry) {
      return resolveStoredSessionMemoryScope(entry);
    }
  } catch {
    // Fall through to key-based defaults below.
  }

  // Standalone local sessions (CLI/TUI) do not always persist through initSessionState.
  // Keep those personal unless they are explicit subagent/cron sessions.
  return resolveSessionMemoryScope({
    SessionKey: sessionKey,
    ChatType: "direct",
  });
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const memoryScope = resolveBootstrapMemoryScope({
    config: params.config,
    sessionKey,
    agentId: params.agentId,
  });
  const baseFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir, {
        includeRecentDailyMemory: memoryScope === "personal",
      });
  const dailyFiles =
    params.sessionKey && memoryScope === "personal"
      ? (
          await loadWorkspaceBootstrapFiles(params.workspaceDir, {
            includeRecentDailyMemory: true,
          })
        ).filter((file) => file.name.startsWith("memory/"))
      : [];
  const rawFiles = [...baseFiles, ...dailyFiles];
  const sessionFiltered = filterBootstrapFilesForSession(rawFiles, sessionKey);
  const bootstrapFiles = applyContextModeFilter({
    files: applyMemoryScopeFilter({
      files: sessionFiltered,
      memoryScope,
    }),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
