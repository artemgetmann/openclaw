import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runResult = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });

const initFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-telegram-"));
  const mainRepo = path.join(root, "main");
  const worktree = path.join(root, "worktree");

  mkdirSync(path.join(mainRepo, "scripts", "telegram-e2e", "tmp"), { recursive: true });
  mkdirSync(path.join(worktree, "scripts"), { recursive: true });

  writeFileSync(path.join(mainRepo, ".env.bots"), "BOT_TOKEN=111:exhausted\n");
  writeFileSync(path.join(mainRepo, "scripts", "telegram-e2e", ".env"), "TG_ENV=canonical\n");
  writeFileSync(
    path.join(mainRepo, "scripts", "telegram-e2e", ".env.local"),
    "TG_LOCAL=canonical-local\n",
  );
  writeFileSync(
    path.join(mainRepo, "scripts", "telegram-e2e", "tmp", "userbot.session"),
    "session-bytes\n",
  );

  symlinkSync(
    path.join(process.cwd(), "scripts", "bootstrap-worktree-telegram.sh"),
    path.join(worktree, "scripts", "bootstrap-worktree-telegram.sh"),
  );
  writeFileSync(
    path.join(worktree, "scripts", "assign-bot.sh"),
    `#!/usr/bin/env bash
echo "Error: no eligible tester bot tokens available." >&2
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );

  return { mainRepo, worktree };
};

describe("bootstrap-worktree-telegram", () => {
  it("copies canonical Telegram assets before an optional exhausted-pool claim failure", () => {
    const { mainRepo, worktree } = initFixture();

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--optional"],
      { OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram bootstrap complete");
    expect(result.stderr).toContain("warning: telegram tester claim deferred; pool exhausted");
    expect(readFileSync(path.join(worktree, ".env.bots"), "utf8")).toContain(
      "BOT_TOKEN=111:exhausted",
    );
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env"), "utf8")).toBe(
      "TG_ENV=canonical\n",
    );
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env.local"), "utf8")).toBe(
      "TG_LOCAL=canonical-local\n",
    );
    expect(
      readFileSync(
        path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session"),
        "utf8",
      ),
    ).toBe("session-bytes\n");
  });

  it("still copies canonical Telegram assets before surfacing a strict exhausted-pool failure", () => {
    const { mainRepo, worktree } = initFixture();

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--strict"],
      { OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: no eligible tester bot tokens available.");
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env.local"), "utf8")).toBe(
      "TG_LOCAL=canonical-local\n",
    );
    expect(
      readFileSync(
        path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session"),
        "utf8",
      ),
    ).toBe("session-bytes\n");
  });
});
