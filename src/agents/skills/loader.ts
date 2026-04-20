import fs from "node:fs";
import path from "node:path";
import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter.js";

type LoadSkillsResult = ReturnType<typeof loadSkillsFromDir>;

function loadFallbackSkillFromFile(filePath: string, source: string): Skill | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const description = frontmatter.description?.trim();
    if (!description) {
      return null;
    }

    const baseDir = path.dirname(filePath);
    const name = frontmatter.name?.trim() || path.basename(baseDir);
    if (!name) {
      return null;
    }

    return {
      name,
      description,
      filePath,
      baseDir,
      source,
      disableModelInvocation: frontmatter["disable-model-invocation"]?.trim() === "true",
    };
  } catch {
    return null;
  }
}

function collectFallbackSkills(params: {
  dir: string;
  source: string;
  knownSkillFiles: ReadonlySet<string>;
}): Skill[] {
  const fallbackSkills: Skill[] = [];
  const stack = [params.dir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      // Follow symlinked skill directories/files, but keep the normal
      // workspace root containment checks in the caller as the final gate.
      if (entry.isSymbolicLink()) {
        try {
          const stats = fs.statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        stack.push(fullPath);
        continue;
      }
      if (!isFile || entry.name !== "SKILL.md") {
        continue;
      }

      const normalizedPath = path.resolve(fullPath);
      if (params.knownSkillFiles.has(normalizedPath)) {
        continue;
      }

      const fallbackSkill = loadFallbackSkillFromFile(normalizedPath, params.source);
      if (fallbackSkill) {
        fallbackSkills.push(fallbackSkill);
      }
    }
  }

  return fallbackSkills;
}

export function loadSkillsFromDirWithFrontmatterFallback(params: {
  dir: string;
  source: string;
}): LoadSkillsResult {
  const loaded = loadSkillsFromDir(params);
  const knownSkillFiles = new Set(loaded.skills.map((skill) => path.resolve(skill.filePath)));

  // Upstream skill loading rejects malformed YAML frontmatter. Our local
  // parser already degrades gracefully for common human-authored cases such
  // as an unquoted colon in `description`, so recover those skills here.
  const fallbackSkills = collectFallbackSkills({
    dir: params.dir,
    source: params.source,
    knownSkillFiles,
  });
  if (fallbackSkills.length === 0) {
    return loaded;
  }

  return {
    ...loaded,
    skills: [...loaded.skills, ...fallbackSkills],
  };
}
