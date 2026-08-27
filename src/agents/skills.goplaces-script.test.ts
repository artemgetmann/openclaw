import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempCwd() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-goplaces-script-"));
  tempDirs.push(dir);
  return dir;
}

function makeMirroredSkillFixture(
  skillDir: string,
  runtimeStateDir: string,
  options: { expectedStateDir?: string; expectedConfigPath?: string } = {},
) {
  const expectedStateDir = options.expectedStateDir ?? runtimeStateDir;
  const expectedConfigPath =
    options.expectedConfigPath ?? path.join(expectedStateDir, "openclaw.json");
  const scriptsDir = path.join(skillDir, "scripts");
  const sourceScriptsDir = path.resolve("skills/goplaces/scripts");
  const runtimeRoot = path.join(runtimeStateDir, "lib", "openclaw-bundled");
  const runtimeDistDir = path.join(runtimeRoot, "dist");

  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(
    path.join(sourceScriptsDir, "goplaces-search.sh"),
    path.join(scriptsDir, "goplaces-search.sh"),
  );
  copyFileSync(
    path.join(sourceScriptsDir, "goplaces-search.mjs"),
    path.join(scriptsDir, "goplaces-search.mjs"),
  );

  // Model the packaged runtime without importing the real repo or contacting
  // Google/Render. The fake config records its state provenance so the public
  // search flow fails if runtime discovery and config discovery split apart.
  mkdirSync(runtimeDistDir, { recursive: true });
  writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    path.join(runtimeDistDir, "index.js"),
    `const expectedStateDir = ${JSON.stringify(expectedStateDir)};
const expectedConfigPath = ${JSON.stringify(expectedConfigPath)};

export function loadConfig() {
  return {
    stateDir: process.env.OPENCLAW_STATE_DIR,
    configPath:
      process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH ?? expectedConfigPath,
  };
}

export async function runGooglePlacesSearch({ cfg, query, limit }) {
  if (cfg.stateDir !== expectedStateDir) {
    throw new Error(\`wrong config state: \${cfg.stateDir ?? "default"}\`);
  }
  if (cfg.configPath !== expectedConfigPath) {
    throw new Error(\`wrong config path: \${cfg.configPath ?? "default"}\`);
  }
  return {
    places: [{ displayName: { text: "Fixture Place" }, formattedAddress: "Test Street" }],
    query,
    limit,
    configPath: cfg.configPath,
    transport: "jarvis-managed",
  };
}
`,
  );
}

function runMirroredWrapper(skillDir: string, env: Record<string, string>) {
  return spawnSync(
    "bash",
    [path.join(skillDir, "scripts", "goplaces-search.sh"), "fixture coffee", "--json"],
    {
      cwd: makeTempCwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
        ...env,
      },
    },
  );
}

function runMirroredModule(skillDir: string, env: Record<string, string>) {
  return spawnSync(
    "node",
    [path.join(skillDir, "scripts", "goplaces-search.mjs"), "fixture coffee", "--json"],
    {
      cwd: makeTempCwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
        ...env,
      },
    },
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("goplaces skill script wrapper", () => {
  it("resolves repo-local runtime dependencies when launched outside the repo", () => {
    const result = spawnSync(
      "bash",
      [path.resolve("skills/goplaces/scripts/goplaces-search.sh"), "--help"],
      {
        cwd: makeTempCwd(),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("goplaces-search.sh [search] <query>");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("loads the packaged runtime from a product skill mirror", () => {
    const rootDir = makeTempCwd();
    const stateDir = path.join(rootDir, "state");
    const skillDir = path.join(stateDir, "product-skills", "goplaces");
    const customConfigPath = path.join(stateDir, "custom.json");
    makeMirroredSkillFixture(skillDir, stateDir, { expectedConfigPath: customConfigPath });
    const result = runMirroredWrapper(skillDir, {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: customConfigPath,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
      configPath: customConfigPath,
      transport: "jarvis-managed",
    });
  });

  it("loads the packaged runtime from a shared personal skill mirror", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(homeDir, "Library", "Application Support", "Jarvis", ".jarvis");
    const skillDir = path.join(homeDir, ".agents", "skills", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    // An equivalent non-canonical HOME must not detach the selected runtime
    // from the state directory it belongs to.
    const result = runMirroredWrapper(skillDir, { HOME: `${homeDir}/` });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
      configPath: path.join(stateDir, "openclaw.json"),
      transport: "jarvis-managed",
    });
  });

  it("keeps the packaged runtime selected by the shell wrapper", () => {
    const rootDir = makeTempCwd();
    const stateDir = path.join(rootDir, "state");
    const checkoutRoot = path.join(rootDir, "checkout");
    const skillDir = path.join(checkoutRoot, "skills", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    // An uninstalled checkout has source but cannot load it without tsx. The
    // wrapper must keep using the packaged dist it already proved was runnable.
    mkdirSync(path.join(checkoutRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(checkoutRoot, "src", "index.ts"),
      'throw new Error("wrong runtime selected");\n',
    );

    const result = runMirroredWrapper(skillDir, { OPENCLAW_STATE_DIR: stateDir });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
      configPath: path.join(stateDir, "openclaw.json"),
      transport: "jarvis-managed",
    });
  });

  it("resolves the packaged runtime when the mirrored module runs directly", () => {
    const rootDir = makeTempCwd();
    const stateDir = path.join(rootDir, "state");
    const skillDir = path.join(rootDir, "mirror", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    const result = runMirroredModule(skillDir, { OPENCLAW_STATE_DIR: stateDir });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
      transport: "jarvis-managed",
    });
  });

  it("preserves an explicit config while inferring the standard packaged state", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(homeDir, "Library", "Application Support", "Jarvis", ".jarvis");
    const skillDir = path.join(homeDir, ".agents", "skills", "goplaces");
    const externalConfigPath = path.join(rootDir, "external-config", "openclaw.json");
    makeMirroredSkillFixture(skillDir, stateDir, { expectedConfigPath: externalConfigPath });
    const env = {
      HOME: homeDir,
      OPENCLAW_CONFIG_PATH: externalConfigPath,
    };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({
        configPath: externalConfigPath,
        transport: "jarvis-managed",
      });
    }
  });

  it("keeps a config-only explicit state while using the standard packaged runtime", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const homeStateDir = path.join(homeDir, "Library", "Application Support", "Jarvis", ".jarvis");
    const explicitStateDir = path.join(rootDir, "explicit-state");
    const skillDir = path.join(homeDir, ".agents", "skills", "goplaces");
    makeMirroredSkillFixture(skillDir, homeStateDir, { expectedStateDir: explicitStateDir });

    const env = {
      HOME: homeDir,
      OPENCLAW_STATE_DIR: explicitStateDir,
    };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({ transport: "jarvis-managed" });
    }
  });

  it("preserves OPENCLAW_HOME isolation while using the standard packaged runtime", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const homeStateDir = path.join(homeDir, "Library", "Application Support", "Jarvis", ".jarvis");
    const isolatedHomeDir = path.join(rootDir, "isolated-home");
    const isolatedStateDir = path.join(isolatedHomeDir, ".openclaw");
    const skillDir = path.join(homeDir, ".agents", "skills", "goplaces");
    makeMirroredSkillFixture(skillDir, homeStateDir, { expectedStateDir: isolatedStateDir });
    mkdirSync(path.join(isolatedHomeDir, ".clawdbot"), { recursive: true });

    const env = { HOME: homeDir, OPENCLAW_HOME: isolatedHomeDir, OPENCLAW_TEST_FAST: "1" };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({ transport: "jarvis-managed" });
    }
  });

  it("preserves a supported external config path with an explicit state", () => {
    const rootDir = makeTempCwd();
    const stateDir = path.join(rootDir, "state");
    const skillDir = path.join(rootDir, "mirror", "goplaces");
    const externalConfigPath = path.join(rootDir, "external-config", "openclaw.json");
    makeMirroredSkillFixture(skillDir, stateDir, { expectedConfigPath: externalConfigPath });
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: externalConfigPath,
    };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({
        configPath: externalConfigPath,
        transport: "jarvis-managed",
      });
    }
  });

  it("expands a tilde-based explicit state for wrapper and direct launches", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const relativeStateDir = "~/packaged-state";
    const stateDir = path.join(homeDir, "packaged-state");
    const skillDir = path.join(rootDir, "mirror", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: relativeStateDir };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({ transport: "jarvis-managed" });
    }
  });

  it("honors a legacy state override when the modern override is blank", () => {
    const rootDir = makeTempCwd();
    const stateDir = path.join(rootDir, "legacy-state");
    const skillDir = path.join(rootDir, "mirror", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    const env = { OPENCLAW_STATE_DIR: " ", CLAWDBOT_STATE_DIR: stateDir };
    const result = runMirroredWrapper(skillDir, env);
    const directResult = runMirroredModule(skillDir, env);

    for (const invocation of [result, directResult]) {
      expect(invocation.status, invocation.stderr).toBe(0);
      expect(JSON.parse(invocation.stdout)).toMatchObject({ transport: "jarvis-managed" });
    }
  });
});
