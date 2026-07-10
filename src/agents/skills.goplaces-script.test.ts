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

function makeMirroredSkillFixture(skillDir: string, stateDir: string) {
  const scriptsDir = path.join(skillDir, "scripts");
  const sourceScriptsDir = path.resolve("skills/goplaces/scripts");
  const runtimeRoot = path.join(stateDir, "lib", "openclaw-bundled");
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
  // Google/Render. The transport marker proves the mirrored wrapper loaded it.
  mkdirSync(runtimeDistDir, { recursive: true });
  writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    path.join(runtimeDistDir, "index.js"),
    `export function loadConfig() {
  return { fixture: true };
}

export async function runGooglePlacesSearch({ query, limit }) {
  return {
    places: [{ displayName: { text: "Fixture Place" }, formattedAddress: "Test Street" }],
    query,
    limit,
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
    makeMirroredSkillFixture(skillDir, stateDir);

    const result = runMirroredWrapper(skillDir, { OPENCLAW_STATE_DIR: stateDir });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
      transport: "jarvis-managed",
    });
  });

  it("loads the packaged runtime from a shared personal skill mirror", () => {
    const rootDir = makeTempCwd();
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(homeDir, "Library", "Application Support", "Jarvis", ".jarvis");
    const skillDir = path.join(homeDir, ".agents", "skills", "goplaces");
    makeMirroredSkillFixture(skillDir, stateDir);

    const result = runMirroredWrapper(skillDir, { HOME: homeDir });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "fixture coffee",
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
});
