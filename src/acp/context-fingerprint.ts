import { createHash } from "node:crypto";
import path from "node:path";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import type { EmbeddedContextFile } from "../agents/pi-embedded-helpers.js";
import { normalizeSkillFilter } from "../agents/skills/filter.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSkillSnapshot } from "../config/sessions/types.js";

function serializeBootstrapFiles(files: WorkspaceBootstrapFile[]) {
  return files.map((file) => ({
    name: file.name,
    path: file.path,
    missing: file.missing,
    content: file.content ?? "",
  }));
}

function serializeContextFiles(files: EmbeddedContextFile[]) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

/**
 * ACP sessions own a long-lived backend conversation, so they need an explicit
 * reset when OpenClaw's bootstrap context changes underneath them.
 */
export async function computeAcpContextFingerprint(params: {
  config?: OpenClawConfig;
  workspaceDir: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  skillsSnapshot?: SessionSkillSnapshot;
}): Promise<string> {
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  const normalizedSkillFilter = normalizeSkillFilter(params.skillsSnapshot?.skillFilter);
  const fingerprintInput = {
    workspaceDir: path.resolve(params.workspaceDir),
    sessionKey: params.sessionKey?.trim() || "",
    agentId: params.agentId?.trim() || "",
    skills: {
      version: params.skillsSnapshot?.version ?? 0,
      prompt: params.skillsSnapshot?.prompt ?? "",
      skillFilter: normalizedSkillFilter ?? null,
      entries:
        params.skillsSnapshot?.skills.map((skill) => ({
          name: skill.name,
          primaryEnv: skill.primaryEnv ?? "",
          requiredEnv: skill.requiredEnv ?? [],
        })) ?? [],
    },
    bootstrapFiles: serializeBootstrapFiles(bootstrapFiles),
    contextFiles: serializeContextFiles(contextFiles),
  };
  return createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
}
