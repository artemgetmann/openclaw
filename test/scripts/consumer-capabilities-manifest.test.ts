import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const manifestScript = path.join(root, "scripts", "consumer-capabilities-manifest.mjs");

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capabilities-manifest-"));
}

function writeSkill(params: {
  root: string;
  name: string;
  displayName?: string;
  install?: string;
}) {
  const skillDir = path.join(params.root, params.name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${params.name}
description: Test ${params.name}
metadata:
  {
    "openclaw":
      {
        ${params.displayName ? `"displayName": "${params.displayName}",` : ""}
        ${params.install ? `"install": [${params.install}],` : ""}
      },
  }
---

# ${params.name}
`,
  );
}

function writeFakeTool(binDir: string, name: string, output: string) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, name);
  fs.writeFileSync(binPath, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
  fs.chmodSync(binPath, 0o755);
}

describe("scripts/consumer-capabilities-manifest.mjs", () => {
  it("emits skill hashes and packaged managed tool version expectations", () => {
    const skillsRoot = makeTempRoot();
    writeSkill({
      root: skillsRoot,
      name: "gog",
      displayName: "Google Workspace",
      install: `{
        "id": "brew",
        "kind": "brew",
        "formula": "steipete/tap/gogcli",
        "bins": ["gog"],
        "versionCommand": ["gog", "--version"],
        "versionRegex": "v?(?<version>[0-9]+\\\\.[0-9]+\\\\.[0-9]+)",
        "recommendedVersion": "0.31.0"
      }`,
    });

    const output = execFileSync(process.execPath, [manifestScript, skillsRoot], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    expect(parsed).toMatchObject({
      format: 1,
      skills: {
        gog: {
          files: 1,
          displayName: "Google Workspace",
          description: "Test gog",
        },
      },
      managedTools: [
        {
          skillName: "gog",
          installId: "brew",
          kind: "brew",
          bins: ["gog"],
          formula: "steipete/tap/gogcli",
          versionCommand: ["gog", "--version"],
          versionRegex: "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
          recommendedVersion: "0.31.0",
        },
      ],
    });
    expect(parsed.skills.gog.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails when a local CLI is newer than packaged release metadata", () => {
    const skillsRoot = makeTempRoot();
    const binDir = path.join(makeTempRoot(), "bin");
    writeFakeTool(binDir, "gog", "gog v0.32.0");
    writeSkill({
      root: skillsRoot,
      name: "gog",
      install: `{
        "id": "brew",
        "kind": "brew",
        "formula": "steipete/tap/gogcli",
        "bins": ["gog"],
        "versionCommand": ["gog", "--version"],
        "versionRegex": "v?(?<version>[0-9]+\\\\.[0-9]+\\\\.[0-9]+)",
        "recommendedVersion": "0.31.0"
      }`,
    });

    const result = spawnSync(
      process.execPath,
      [manifestScript, skillsRoot, "--check-local-drift", "--fail-on-local-drift"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local tool is newer than packaged release metadata: gog");
    expect(result.stderr).toContain("local_version=0.32.0");
    expect(result.stderr).toContain("packaged_recommended_version=0.31.0");
  });

  it("allows intentional local drift override during packaging", () => {
    const skillsRoot = makeTempRoot();
    const binDir = path.join(makeTempRoot(), "bin");
    writeFakeTool(binDir, "gog", "gog v0.32.0");
    writeSkill({
      root: skillsRoot,
      name: "gog",
      install: `{
        "kind": "brew",
        "formula": "steipete/tap/gogcli",
        "versionCommand": ["gog", "--version"],
        "recommendedVersion": "0.31.0"
      }`,
    });

    const result = spawnSync(
      process.execPath,
      [manifestScript, skillsRoot, "--check-local-drift", "--fail-on-local-drift"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CONSUMER_ALLOW_CAPABILITY_DRIFT: "1",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("local tool is newer than packaged release metadata: gog");
  });

  it("does not fail when the local CLI is missing", () => {
    const skillsRoot = makeTempRoot();
    writeSkill({
      root: skillsRoot,
      name: "gog",
      install: `{
        "kind": "brew",
        "formula": "steipete/tap/gogcli",
        "versionCommand": ["definitely-missing-gog-for-test", "--version"],
        "recommendedVersion": "0.31.0"
      }`,
    });

    const result = spawnSync(
      process.execPath,
      [manifestScript, skillsRoot, "--check-local-drift", "--fail-on-local-drift"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
