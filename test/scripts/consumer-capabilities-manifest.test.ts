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
  packagedArtifacts?: string;
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
        ${params.packagedArtifacts ? `"packagedArtifacts": [${params.packagedArtifacts}],` : ""}
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
  it("includes the bundled find-food skill with its consumer display name", () => {
    const output = execFileSync(process.execPath, [manifestScript, path.join(root, "skills")], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    expect(parsed.skills["find-food"]).toMatchObject({
      files: 1,
      displayName: "Find Something to Eat",
    });
    expect(parsed.skills["find-food"].description).toContain("what should I eat?");
    expect(parsed.skills["find-food"].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes the bundled personal tone skill and all profile assets", () => {
    const output = execFileSync(process.execPath, [manifestScript, path.join(root, "skills")], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    expect(parsed.skills["personal-tone-of-voice"]).toMatchObject({
      files: 3,
      displayName: "Personal Tone of Voice",
    });
    expect(parsed.skills["personal-tone-of-voice"].description).toContain(
      "every WhatsApp, Telegram, email, SMS/iMessage",
    );
    expect(parsed.skills["personal-tone-of-voice"].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits skill hashes and packaged managed tool version expectations", () => {
    const skillsRoot = makeTempRoot();
    writeSkill({
      root: skillsRoot,
      name: "gog",
      displayName: "Google Workspace",
      install: `{
        "id": "brew",
        "kind": "brew",
        "formula": "openclaw/tap/gogcli",
        "bins": ["gog"],
        "versionCommand": ["gog", "--version"],
        "versionRegex": "v?(?<version>[0-9]+\\\\.[0-9]+\\\\.[0-9]+)",
        "recommendedVersion": "0.33.0"
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
          formula: "openclaw/tap/gogcli",
          versionCommand: ["gog", "--version"],
          versionRegex: "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
          recommendedVersion: "0.33.0",
        },
      ],
    });
    expect(parsed.skills.gog.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits release-required native artifacts from skill metadata", () => {
    const skillsRoot = makeTempRoot();
    writeSkill({
      root: skillsRoot,
      name: "computer-use",
      packagedArtifacts: `{
        "id": "open-computer-use",
        "kind": "macos-app",
        "requirement": "consumer-release",
        "path": "native/Open Computer Use.app",
        "executable": "Contents/MacOS/OpenComputerUse",
        "bundleIdentifier": "com.ifuryst.opencomputeruse",
        "version": "0.1.53",
        "architectures": ["x86_64", "arm64"],
        "sourceRepo": "https://example.test/open-computer-use.git",
        "sourceRef": "a8ad90ed703fbdc2095e900c2b2574bfa4d60f36",
        "buildCommand": ["./scripts/build.sh", "release", "--arch", "universal"],
        "licenseSource": "LICENSE",
        "licensePath": "Contents/Resources/LICENSE.txt",
        "receiptPath": "Contents/Resources/receipt.json"
      }`,
    });

    const output = execFileSync(process.execPath, [manifestScript, skillsRoot], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    expect(parsed.packagedArtifacts).toEqual([
      expect.objectContaining({
        skillName: "computer-use",
        id: "open-computer-use",
        requirement: "consumer-release",
        architectures: ["arm64", "x86_64"],
        sourceRef: "a8ad90ed703fbdc2095e900c2b2574bfa4d60f36",
      }),
    ]);
  });

  it("pins the bundled Open Computer Use artifact to the merged handshake fix", () => {
    const output = execFileSync(process.execPath, [manifestScript, path.join(root, "skills")], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    const artifact = parsed.packagedArtifacts.find(
      (candidate: { id?: string }) => candidate.id === "open-computer-use",
    );

    expect(artifact).toMatchObject({
      skillName: "jarvis-computer-use",
      sourceRepo: "https://github.com/artemgetmann/open-codex-computer-use.git",
      sourceRef: "658d72ad5cfbab60bfb477a8b54fcac9dd659121",
    });
  });

  it("rejects unsafe release artifact paths", () => {
    const skillsRoot = makeTempRoot();
    writeSkill({
      root: skillsRoot,
      name: "computer-use",
      packagedArtifacts: `{
        "id": "escape",
        "kind": "macos-app",
        "requirement": "consumer-release",
        "path": "../Escape.app",
        "executable": "Contents/MacOS/Escape",
        "bundleIdentifier": "test.escape",
        "version": "1.0.0",
        "architectures": ["arm64"],
        "sourceRepo": "https://example.test/escape.git",
        "sourceRef": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "buildCommand": ["./build.sh"],
        "licenseSource": "LICENSE",
        "licensePath": "Contents/Resources/LICENSE.txt",
        "receiptPath": "Contents/Resources/receipt.json"
      }`,
    });

    const result = spawnSync(process.execPath, [manifestScript, skillsRoot], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid packaged artifact path");
  });

  it("tracks the supported summarize CLI version from the bundled skill", () => {
    const output = execFileSync(process.execPath, [manifestScript, path.join(root, "skills")], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    expect(parsed.managedTools).toContainEqual(
      expect.objectContaining({
        skillName: "summarize",
        installId: "brew",
        kind: "brew",
        bins: ["summarize"],
        formula: "summarize",
        versionCommand: ["summarize", "--version"],
        recommendedVersion: "0.21.6",
      }),
    );
  });

  it("fails when a local CLI is newer than packaged release metadata", () => {
    const skillsRoot = makeTempRoot();
    const binDir = path.join(makeTempRoot(), "bin");
    writeFakeTool(binDir, "gog", "gog v0.34.0");
    writeSkill({
      root: skillsRoot,
      name: "gog",
      install: `{
        "id": "brew",
        "kind": "brew",
        "formula": "openclaw/tap/gogcli",
        "bins": ["gog"],
        "versionCommand": ["gog", "--version"],
        "versionRegex": "v?(?<version>[0-9]+\\\\.[0-9]+\\\\.[0-9]+)",
        "recommendedVersion": "0.33.0"
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
    expect(result.stderr).toContain("local_version=0.34.0");
    expect(result.stderr).toContain("packaged_recommended_version=0.33.0");
  });

  it("allows intentional local drift override during packaging", () => {
    const skillsRoot = makeTempRoot();
    const binDir = path.join(makeTempRoot(), "bin");
    writeFakeTool(binDir, "gog", "gog v0.34.0");
    writeSkill({
      root: skillsRoot,
      name: "gog",
      install: `{
        "kind": "brew",
        "formula": "openclaw/tap/gogcli",
        "versionCommand": ["gog", "--version"],
        "recommendedVersion": "0.33.0"
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
        "formula": "openclaw/tap/gogcli",
        "versionCommand": ["definitely-missing-gog-for-test", "--version"],
        "recommendedVersion": "0.33.0"
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
