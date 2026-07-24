import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "telegram-tester-scenario-reservations.mjs"),
    path.join(repoDir, "scripts", "lib", "telegram-tester-scenario-reservations.mjs"),
  );
};

describe("assign-bot stale claim reclaim", () => {
  it("uses a fresh run identity when a worktree path is recreated without its owner file", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-incarnation-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");

    const firstOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home });
    expect(firstOutput).toContain("Assigned Telegram bot token #1");
    const firstEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    const firstGeneration = firstEnv.match(
      /^OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=(.+)$/m,
    )?.[1];

    const resumedOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home });
    expect(resumedOutput).toContain("Retained Telegram bot token #1");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toBe(firstEnv);

    // Deleting/recreating a worktree removes its local owner file but can reuse
    // the same path. The old global reservation must not authenticate that new
    // incarnation merely because the path string matches.
    rmSync(path.join(mainDir, ".env.local"));
    const recreatedOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home });
    expect(recreatedOutput).toContain("Assigned Telegram bot token #2");
    const recreatedEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    const recreatedGeneration = recreatedEnv.match(
      /^OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=(.+)$/m,
    )?.[1];
    expect(recreatedGeneration).toBeTruthy();
    expect(recreatedGeneration).not.toBe(firstGeneration);
    expect(recreatedEnv).toContain(
      `OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION=${recreatedGeneration}`,
    );
  });

  it("does not adopt a durable reservation when the local generation is stale", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-generation-aba-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");

    run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
    });
    const envLocalPath = path.join(mainDir, ".env.local");
    const original = readFileSync(envLocalPath, "utf8");
    const corrupted = original.replace(
      /^OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=.+$/m,
      "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=stale-local-generation",
    );
    writeFileSync(envLocalPath, corrupted);

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(corrupted);
    expect(corrupted).toContain("TELEGRAM_BOT_TOKEN=111:first");
  });

  it("does not adopt a durable reservation when local owner credentials are missing", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-missing-owner-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");

    run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
    });
    const envLocalPath = path.join(mainDir, ".env.local");
    const partial = readFileSync(envLocalPath, "utf8")
      .split(/\r?\n/u)
      .filter(
        (line) =>
          !line.startsWith("OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=") &&
          !line.startsWith("OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH="),
      )
      .join("\n");
    writeFileSync(envLocalPath, partial);

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(partial);
    expect(partial).toContain("TELEGRAM_BOT_TOKEN=111:first");
  });

  it("consults the live polling-lease registry before reserving a candidate", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-lease-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:leased\nBOT_TOKEN=222:free\n");
    const leasedToken = "111:leased";
    const tokenHash = crypto.createHash("sha256").update(leasedToken).digest("hex");
    writeFileSync(
      path.join(leaseRoot, `111-${tokenHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        botId: "111",
        accountId: "default",
        configPath: null,
        worktree: path.join(root, "other-worktree"),
      }),
    );

    const output = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
    });

    expect(output).toContain("Assigned Telegram bot token #2");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("222:free");
  });

  it("does not reserve under an unreserved live runtime in the same worktree", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-same-worktree-lease-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:live\nBOT_TOKEN=222:free\n");
    const leasedToken = "111:live";
    const tokenHash = crypto.createHash("sha256").update(leasedToken).digest("hex");
    writeFileSync(
      path.join(leaseRoot, `111-${tokenHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        botId: "111",
        accountId: "default",
        configPath: null,
        worktree: mainDir,
      }),
    );

    const output = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
    });

    expect(output).toContain("Assigned Telegram bot token #2");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("222:free");
    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    expect(
      readFileSync(
        path.join(
          reservationRoot,
          `222-${crypto.createHash("sha256").update("222:free").digest("hex")}.json`,
        ),
        "utf8",
      ),
    ).toContain('"scenarioId": "new-scenario"');
  });

  it("keeps a malformed polling lease unavailable instead of assigning its token", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-malformed-lease-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:ambiguous\nBOT_TOKEN=222:free\n");
    const ambiguousToken = "111:ambiguous";
    const tokenHash = crypto.createHash("sha256").update(ambiguousToken).digest("hex");
    writeFileSync(path.join(leaseRoot, `111-${tokenHash}.json`), "{ malformed\n");

    const output = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
    });

    expect(output).toContain("Assigned Telegram bot token #2");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("222:free");
  });

  it("keeps a dead-runtime bot pinned to its unfinished scenario", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-scenario-");
    installAssignBotFixture(mainDir);
    mkdirSync(path.join(root, "home", ".openclaw"), { recursive: true });
    writeFileSync(path.join(root, "home", ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:pinned\nBOT_TOKEN=222:free\n");
    run(mainDir, "git", ["add", "."]);
    run(mainDir, "git", ["commit", "-m", "fixture"]);

    const scenarioDir = path.join(root, "scenario-lane");
    run(mainDir, "git", ["worktree", "add", scenarioDir, "-b", "codex/scenario-lane", "HEAD"]);
    const scenarioOutput = run(scenarioDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: path.join(root, "home"),
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "unfinished-booking",
    });
    expect(scenarioOutput).toContain("Assigned Telegram bot token #1");
    const firstEnv = readFileSync(path.join(scenarioDir, ".env.local"), "utf8");
    const ownToken = "111:pinned";
    const ownTokenHash = crypto.createHash("sha256").update(ownToken).digest("hex");
    const ownLeaseRoot = path.join(root, "home", ".openclaw", "telegram-token-leases");
    mkdirSync(ownLeaseRoot, { recursive: true });
    writeFileSync(
      path.join(ownLeaseRoot, `111-${ownTokenHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash: ownTokenHash,
        tokenFingerprint: ownTokenHash.slice(0, 12),
        botId: "111",
        accountId: "default",
        configPath: null,
        worktree: scenarioDir,
      }),
    );
    const resumedOutput = run(scenarioDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: path.join(root, "home"),
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "unfinished-booking",
    });
    expect(resumedOutput).toContain("Retained Telegram bot token #1");
    expect(readFileSync(path.join(scenarioDir, ".env.local"), "utf8")).toBe(firstEnv);

    const nextOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: path.join(root, "home"),
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "unrelated-scenario",
    });

    expect(nextOutput).toContain("Assigned Telegram bot token #2");
    expect(readFileSync(path.join(scenarioDir, ".env.local"), "utf8")).toContain("111:pinned");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toContain("222:free");
  });

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
