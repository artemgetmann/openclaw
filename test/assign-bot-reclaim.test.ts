import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();

const initRepo = (prefix: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const mainDir = path.join(root, "repo");
  mkdirSync(mainDir, { recursive: true });
  run(root, "git", ["init", mainDir, "--initial-branch=main"]);
  run(mainDir, "git", ["config", "user.name", "Test User"]);
  run(mainDir, "git", ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(mainDir, "README.md"), "seed\n");
  run(mainDir, "git", ["add", "README.md"]);
  run(mainDir, "git", ["commit", "-m", "seed"]);
  return { root, mainDir };
};

const installAssignBotFixture = (repoDir: string) => {
  mkdirSync(path.join(repoDir, "scripts", "lib"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "assign-bot.sh"),
    path.join(repoDir, "scripts", "assign-bot.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "telegram-live-runtime-helpers.mjs"),
    path.join(repoDir, "scripts", "lib", "telegram-live-runtime-helpers.mjs"),
  );
};

describe("assign-bot stale claim reclaim", () => {
  it("reclaims a stale tester bot claim before assigning it", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-stale-");
    installAssignBotFixture(mainDir);
    mkdirSync(path.join(root, "home", ".openclaw"), { recursive: true });
    writeFileSync(path.join(root, "home", ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:stale\nBOT_TOKEN=222:free\n");
    run(mainDir, "git", ["add", "."]);
    run(mainDir, "git", ["commit", "-m", "fixture"]);

    const staleDir = path.join(root, "stale-lane");
    run(mainDir, "git", ["worktree", "add", staleDir, "-b", "codex/stale-lane", "HEAD"]);
    mkdirSync(path.join(staleDir, "scripts"), { recursive: true });
    writeFileSync(path.join(staleDir, ".env.local"), "TELEGRAM_BOT_TOKEN=111:stale\n");

    const output = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: path.join(root, "home"),
    });

    expect(output).toContain("Assigned Telegram bot token #1");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("111:stale");
    expect(readFileSync(path.join(staleDir, ".env.local"), "utf8")).not.toContain("111:stale");
  });

  it("does not reclaim an active tester bot claim", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-active-");
    installAssignBotFixture(mainDir);
    mkdirSync(path.join(root, "home", ".openclaw"), { recursive: true });
    writeFileSync(path.join(root, "home", ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:active\nBOT_TOKEN=222:free\n");
    run(mainDir, "git", ["add", "."]);
    run(mainDir, "git", ["commit", "-m", "fixture"]);

    const activeDir = path.join(root, "active-lane");
    run(mainDir, "git", ["worktree", "add", activeDir, "-b", "codex/active-lane", "HEAD"]);
    writeFileSync(path.join(activeDir, ".env.local"), "TELEGRAM_BOT_TOKEN=111:active\n");

    const stubDir = path.join(root, "stubs");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      path.join(stubDir, "lsof"),
      `#!/usr/bin/env bash
if [[ "$*" == *"-tiTCP:"* ]]; then
  printf '4242\\n'
  exit 0
fi
if [[ "$*" == *"-a -p 4242 -d cwd -Fn"* ]]; then
  printf 'n${activeDir}\\n'
  exit 0
fi
exit 0
`,
      { encoding: "utf8", mode: 0o755 },
    );
    writeFileSync(
      path.join(stubDir, "ps"),
      "#!/usr/bin/env bash\nprintf 'node dist/index.js gateway run --port 20123\\n'\n",
      { encoding: "utf8", mode: 0o755 },
    );

    const output = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: path.join(root, "home"),
      PATH: `${stubDir}:${process.env.PATH}`,
    });

    expect(output).toContain("Assigned Telegram bot token #2");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("222:free");
    expect(readFileSync(path.join(activeDir, ".env.local"), "utf8")).toContain("111:active");
  });
});
