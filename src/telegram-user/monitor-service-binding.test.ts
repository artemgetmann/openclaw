import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTelegramUserMonitorBinding,
  readTelegramUserMonitorBinding,
  resolveTelegramUserMonitorBindingPath,
  summarizeTelegramUserMonitorBinding,
  writeTelegramUserMonitorBinding,
} from "./monitor-service-binding.js";

const roots: string[] = [];

async function makeEnv() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-binding-"));
  roots.push(stateDir);
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("telegram-user monitor service binding", () => {
  it("atomically stores normalized selectors in the resolved state directory", async () => {
    const env = await makeEnv();
    await writeTelegramUserMonitorBinding({
      env,
      envFile: " ./telegram.env ",
      session: " ./account.session ",
    });

    expect(await readTelegramUserMonitorBinding(env)).toEqual({
      envFile: path.resolve("telegram.env"),
      session: path.resolve("account.session"),
    });
    expect((await fs.stat(resolveTelegramUserMonitorBindingPath(env))).mode & 0o777).toBe(0o600);
  });

  it("summarizes readiness without exposing selector paths", async () => {
    const env = await makeEnv();
    const envFile = path.join(env.OPENCLAW_STATE_DIR!, "account.env");
    await fs.writeFile(envFile, "TELEGRAM_API_ID=1\n");
    await writeTelegramUserMonitorBinding({
      env,
      envFile,
      session: path.join(env.OPENCLAW_STATE_DIR!, "missing.session"),
    });

    const summary = await summarizeTelegramUserMonitorBinding(env);
    expect(summary).toEqual({
      configured: true,
      source: "profile-state",
      envFile: { configured: true, present: true },
      session: { configured: true, present: false },
    });
    expect(JSON.stringify(summary)).not.toContain(env.OPENCLAW_STATE_DIR);
  });

  it("treats a successful install with default selectors as an explicit empty binding", async () => {
    const env = await makeEnv();
    await writeTelegramUserMonitorBinding({ env });

    expect(await readTelegramUserMonitorBinding(env)).toEqual({});
    expect(await summarizeTelegramUserMonitorBinding(env)).toMatchObject({
      configured: true,
      source: "profile-state",
      envFile: { configured: false },
      session: { configured: false },
    });
  });

  it("restores binding absence by removing the persisted file", async () => {
    const env = await makeEnv();
    await writeTelegramUserMonitorBinding({ env, envFile: "./telegram.env" });

    await clearTelegramUserMonitorBinding(env);

    await expect(fs.access(resolveTelegramUserMonitorBindingPath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readTelegramUserMonitorBinding(env)).resolves.toBeNull();
  });
});
