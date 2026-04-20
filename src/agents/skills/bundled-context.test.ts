import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveBundledSkillsContext } from "./bundled-context.js";

describe("resolveBundledSkillsContext", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
  });

  afterEach(async () => {
    envSnapshot.restore();
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("includes fallback-loaded bundled skills whose frontmatter is not strict YAML", async () => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-context-"));
    tempDirs.push(bundledDir);
    const skillDir = path.join(bundledDir, "telegram-user");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: telegram-user
description: Use for Telegram-as-me requests on this Mac: reading, sending, replying, or waiting as the user's real Telegram account.
---

# Telegram User
`,
      "utf-8",
    );
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;

    const context = resolveBundledSkillsContext();

    expect(context.dir).toBe(bundledDir);
    expect(context.names.has("telegram-user")).toBe(true);
  });
});
