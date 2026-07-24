import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseLegacyTelegramTesterTokenAssignment,
  releaseTelegramTesterScenarioReservation,
} from "../scripts/lib/telegram-tester-scenario-reservations.mjs";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();

const runAsync = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`Command failed with exit ${String(code)}: ${stderr.trim()}`));
    });
  });

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
    const firstTokenHash = crypto.createHash("sha256").update("111:first").digest("hex");
    expect(firstEnv).toContain(`OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH=${firstTokenHash}`);
    expect(firstEnv).toContain("OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID=default");

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

  it("recovers the same generated scenario after interruption during assignment", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-crash-recovery-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_ASSIGN_ABORT_AFTER_RESERVATION: "1",
      }),
    ).toThrow();

    const intentEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    const scenarioId = intentEnv.match(
      /^OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=(tg-scenario-.+)$/m,
    )?.[1];
    expect(scenarioId).toBeTruthy();
    expect(intentEnv).not.toContain("TELEGRAM_BOT_TOKEN=");

    const recoveredOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home });
    expect(recoveredOutput).toContain("Assigned Telegram bot token #1");
    const recoveredEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    expect(recoveredEnv).toContain(`OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=${scenarioId}`);
    expect(recoveredEnv).toContain("TELEGRAM_BOT_TOKEN=111:first");
  });

  it("persists an explicit scenario override before interrupted reservation publication", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-override-recovery-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");
    writeFileSync(
      path.join(mainDir, ".env.local"),
      "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=old-scenario\nKEEP_ME=yes\n",
    );

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "replacement-scenario",
        OPENCLAW_TELEGRAM_TESTER_ASSIGN_ABORT_AFTER_RESERVATION: "1",
      }),
    ).toThrow();

    const interruptedEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    expect(interruptedEnv).toContain("OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=replacement-scenario");
    expect(interruptedEnv).not.toContain("OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=old-scenario");
    expect(interruptedEnv).toContain("KEEP_ME=yes");
    expect(interruptedEnv).not.toContain("TELEGRAM_BOT_TOKEN=");

    const recoveredOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home });
    expect(recoveredOutput).toContain("Assigned Telegram bot token #1");
    expect(recoveredOutput).toContain("Scenario ID: replacement-scenario");
    const recoveredEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    expect(recoveredEnv).toContain("OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=replacement-scenario");
    expect(recoveredEnv).toContain("TELEGRAM_BOT_TOKEN=111:first");
  });

  it("requires release before replacing an expired exact-owner generation", async () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-expired-owner-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\nBOT_TOKEN=222:second\n");

    run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "expired-owner-scenario",
    });
    const envLocalPath = path.join(mainDir, ".env.local");
    const originalEnv = readFileSync(envLocalPath, "utf8");
    const originalGeneration = originalEnv.match(
      /^OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=(.+)$/m,
    )?.[1];
    expect(originalGeneration).toBeTruthy();
    const token = "111:first";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const reservationPath = path.join(reservationRoot, `111-${tokenHash}.json`);
    const expiredReservation = JSON.parse(readFileSync(reservationPath, "utf8"));
    expiredReservation.createdAt = "2026-07-01T00:00:00.000Z";
    expiredReservation.updatedAt = "2026-07-01T00:00:00.000Z";
    expiredReservation.expiresAt = "2026-07-02T00:00:00.000Z";
    writeFileSync(reservationPath, `${JSON.stringify(expiredReservation, null, 2)}\n`);

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "expired-owner-scenario",
        OPENCLAW_TELEGRAM_TESTER_ASSIGN_ABORT_AFTER_RESERVATION: "1",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(originalEnv);
    expect(readFileSync(reservationPath, "utf8")).toContain(String(originalGeneration));

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "expired-owner-scenario",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(originalEnv);

    const released = await releaseTelegramTesterScenarioReservation({
      token,
      scenarioId: "expired-owner-scenario",
      worktreePath: mainDir,
      generation: String(originalGeneration),
      envLocalPath,
      reservationRoot,
    });
    expect(released).toMatchObject({ ok: true, reason: "released" });

    const recoveredOutput = run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "expired-owner-scenario",
    });
    expect(recoveredOutput).toContain("Assigned Telegram bot token #1");
    const recoveredGeneration = readFileSync(envLocalPath, "utf8").match(
      /^OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=(.+)$/m,
    )?.[1];
    expect(recoveredGeneration).toBeTruthy();
    expect(recoveredGeneration).not.toBe(originalGeneration);
  });

  it("serializes concurrent fresh assignments without leaking bot reservations", async () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-concurrent-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(
      path.join(mainDir, ".env.bots"),
      Array.from({ length: 8 }, (_, index) => `BOT_TOKEN=${index + 111}:token-${index + 1}`).join(
        "\n",
      ) + "\n",
    );
    writeFileSync(path.join(mainDir, ".env.local"), "KEEP_ME=yes\n");

    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        runAsync(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home }),
      ),
    );

    expect(
      outputs.filter((output) => output.includes("Assigned Telegram bot token #1")),
    ).toHaveLength(1);
    expect(
      outputs.filter((output) => output.includes("Retained Telegram bot token #1")),
    ).toHaveLength(7);
    const scenarioIds = outputs.map((output) => output.match(/^Scenario ID: (.+)$/m)?.[1]);
    const generations = outputs.map(
      (output) => output.match(/^Reservation generation: (.+)$/m)?.[1],
    );
    expect(scenarioIds.every(Boolean)).toBe(true);
    expect(generations.every(Boolean)).toBe(true);
    expect(new Set(scenarioIds).size).toBe(1);
    expect(new Set(generations).size).toBe(1);
    const envContent = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    expect(envContent).toContain("KEEP_ME=yes");
    expect(envContent).toContain("TELEGRAM_BOT_TOKEN=111:token-1");
    expect(envContent).toContain(`OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=${scenarioIds[0]}`);
    expect(envContent).toContain(
      `OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=${generations[0]}`,
    );
    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    const reservationFiles = readdirSync(reservationRoot).filter((name) => name.endsWith(".json"));
    expect(reservationFiles).toHaveLength(1);
    const reservationContent = readFileSync(
      path.join(reservationRoot, reservationFiles[0]),
      "utf8",
    );
    expect(reservationContent).toContain(`"scenarioId": "${scenarioIds[0]}"`);
    expect(reservationContent).toContain(`"generation": "${generations[0]}"`);
    expect(readdirSync(mainDir).filter((name) => name.includes("assignment.lock"))).toEqual([]);
  });

  it("fails closed on a crash-persistent worktree assignment lock", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-stale-lock-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:first\n");
    const lockDir = path.join(mainDir, ".openclaw-telegram-tester-assignment.lock");
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "owner.pid"), "999999999\n");
    writeFileSync(
      path.join(lockDir, "owner.json"),
      '{"version":1,"pid":999999999,"createdAt":"2026-07-24T00:00:00Z"}\n',
    );

    expect(() => run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home })).toThrow(
      /stale tester-bot assignment lock requires manual recovery/,
    );
    expect(readFileSync(path.join(lockDir, "owner.pid"), "utf8")).toBe("999999999\n");
    expect(
      readdirSync(path.join(home, ".openclaw")).filter((name) =>
        name.includes("telegram-tester-scenario-reservations"),
      ),
    ).toEqual([]);
  });

  it("preserves unrelated local settings when assignment cannot claim a bot", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-preserve-failure-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    const leasedToken = "111:leased";
    const tokenHash = crypto.createHash("sha256").update(leasedToken).digest("hex");
    writeFileSync(path.join(mainDir, ".env.bots"), `BOT_TOKEN=${leasedToken}\n`);
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
    writeFileSync(path.join(mainDir, ".env.local"), "KEEP_ME=yes\n");

    expect(() => run(mainDir, "bash", ["scripts/assign-bot.sh"], { HOME: home })).toThrow();

    const envContent = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    expect(envContent).toContain("KEEP_ME=yes");
    expect(envContent).toMatch(/^OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=tg-scenario-.+$/m);
    expect(envContent).not.toContain("TELEGRAM_BOT_TOKEN=");
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

  it("requires explicit release before upgrading an active legacy runtime", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-same-worktree-lease-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:live\nBOT_TOKEN=222:free\n");
    writeFileSync(path.join(mainDir, ".env.local"), "TELEGRAM_BOT_TOKEN=111:live\nKEEP_ME=yes\n");
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

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
      }),
    ).toThrow();
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toBe(
      "TELEGRAM_BOT_TOKEN=111:live\nKEEP_ME=yes\n",
    );
    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    const reservationPath = path.join(
      reservationRoot,
      `111-${crypto.createHash("sha256").update("111:live").digest("hex")}.json`,
    );
    expect(() => readFileSync(reservationPath, "utf8")).toThrow();
  });

  it("leaves a dead legacy claim releasable after ensure fails closed", async () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-dead-legacy-release-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:dead\nBOT_TOKEN=222:free\n");
    const envLocalPath = path.join(mainDir, ".env.local");
    const originalEnv = "TELEGRAM_BOT_TOKEN=111:dead\nKEEP_ME=yes\n";
    writeFileSync(envLocalPath, originalEnv);

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(originalEnv);

    const released = await releaseLegacyTelegramTesterTokenAssignment({
      token: "111:dead",
      envLocalPath,
      reservationRoot: path.join(home, ".openclaw", "telegram-tester-scenario-reservations"),
    });
    expect(released).toMatchObject({ ok: true, reason: "legacy_assignment_released" });
    expect(readFileSync(envLocalPath, "utf8")).toBe("KEEP_ME=yes\n");
  });

  it("does not let a dead legacy claim reclaim an expired foreign reservation", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-dead-legacy-expired-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    mkdirSync(reservationRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:dead\nBOT_TOKEN=222:free\n");
    const envLocalPath = path.join(mainDir, ".env.local");
    const originalEnv = "TELEGRAM_BOT_TOKEN=111:dead\nKEEP_ME=yes\n";
    writeFileSync(envLocalPath, originalEnv);

    const token = "111:dead";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const reservationPath = path.join(reservationRoot, `111-${tokenHash}.json`);
    const expiredGeneration = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      reservationPath,
      `${JSON.stringify({
        version: 1,
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        botId: "111",
        scenarioId: "foreign-expired-scenario",
        worktreePath: path.join(root, "foreign-worktree"),
        generation: expiredGeneration,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-02T00:00:00.000Z",
        requiresSafeReuseFence: true,
      })}\n`,
    );

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
      }),
    ).toThrow();
    expect(readFileSync(envLocalPath, "utf8")).toBe(originalEnv);
    expect(readFileSync(reservationPath, "utf8")).toContain(expiredGeneration);
    const secondHash = crypto.createHash("sha256").update("222:free").digest("hex");
    expect(() =>
      readFileSync(path.join(reservationRoot, `222-${secondHash}.json`), "utf8"),
    ).toThrow();
  });

  it("fails closed when an active legacy owner also has a foreign active-looking claim", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-legacy-claim-conflict-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:live\nBOT_TOKEN=222:free\n");
    const originalEnv = "TELEGRAM_BOT_TOKEN=111:live\nKEEP_ME=yes\n";
    writeFileSync(path.join(mainDir, ".env.local"), originalEnv);
    run(mainDir, "git", ["add", "."]);
    run(mainDir, "git", ["commit", "-m", "fixture"]);

    const copiedDir = path.join(root, "copied-legacy-lane");
    run(mainDir, "git", ["worktree", "add", copiedDir, "-b", "codex/copied-legacy", "HEAD"]);
    writeFileSync(path.join(copiedDir, ".env.local"), "TELEGRAM_BOT_TOKEN=111:live\n");

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
  printf 'n${copiedDir}\\n'
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

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        PATH: `${stubDir}:${process.env.PATH}`,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "new-scenario",
      }),
    ).toThrow();
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toBe(originalEnv);

    const reservationRoot = path.join(home, ".openclaw", "telegram-tester-scenario-reservations");
    const firstReservation = path.join(reservationRoot, `111-${tokenHash}.json`);
    const secondHash = crypto.createHash("sha256").update("222:free").digest("hex");
    const secondReservation = path.join(reservationRoot, `222-${secondHash}.json`);
    expect(() => readFileSync(firstReservation, "utf8")).toThrow();
    expect(() => readFileSync(secondReservation, "utf8")).toThrow();
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

  it("retains its exact reservation when another worktree copied the token claim", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-copied-claim-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:owned\nBOT_TOKEN=222:free\n");
    run(mainDir, "git", ["add", "."]);
    run(mainDir, "git", ["commit", "-m", "fixture"]);

    run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
    });
    const originalEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    const copiedDir = path.join(root, "copied-lane");
    run(mainDir, "git", ["worktree", "add", copiedDir, "-b", "codex/copied-lane", "HEAD"]);
    writeFileSync(path.join(copiedDir, ".env.local"), "TELEGRAM_BOT_TOKEN=111:owned\n");

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
  printf 'n${copiedDir}\\n'
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
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
    });

    expect(output).toContain("Retained Telegram bot token #1");
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toBe(originalEnv);
    expect(readFileSync(path.join(copiedDir, ".env.local"), "utf8")).toContain("111:owned");
  });

  it("does not rotate an exact reservation while a foreign polling lease blocks it", () => {
    const { root, mainDir } = initRepo("openclaw-assign-bot-foreign-lease-");
    installAssignBotFixture(mainDir);
    const home = path.join(root, "home");
    const leaseRoot = path.join(home, ".openclaw", "telegram-token-leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n");
    writeFileSync(path.join(mainDir, ".env.bots"), "BOT_TOKEN=111:owned\nBOT_TOKEN=222:free\n");

    run(mainDir, "bash", ["scripts/assign-bot.sh"], {
      HOME: home,
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
    });
    const originalEnv = readFileSync(path.join(mainDir, ".env.local"), "utf8");
    const tokenHash = crypto.createHash("sha256").update("111:owned").digest("hex");
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
        worktree: path.join(root, "foreign-runtime"),
      }),
    );

    expect(() =>
      run(mainDir, "bash", ["scripts/assign-bot.sh"], {
        HOME: home,
        OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-a",
      }),
    ).toThrow();
    expect(readFileSync(path.join(mainDir, ".env.local"), "utf8")).toBe(originalEnv);

    const secondHash = crypto.createHash("sha256").update("222:free").digest("hex");
    const secondReservation = path.join(
      home,
      ".openclaw",
      "telegram-tester-scenario-reservations",
      `222-${secondHash}.json`,
    );
    expect(() => readFileSync(secondReservation, "utf8")).toThrow();
  });
});
