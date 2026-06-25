import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import type { SkillEntry } from "./skills/types.js";

describe("buildWorkspaceSkillStatus", () => {
  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: {
        name: "os-scoped",
        description: "test",
        source: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toEqual([]);
  });

  it("surfaces advisory tool version status for install specs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-status-"));
    const fakeBin = path.join(tempDir, "fakebin");
    fs.writeFileSync(fakeBin, "#!/usr/bin/env sh\necho 'fakebin 1.1.0'\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const entry: SkillEntry = {
        skill: {
          name: "versioned",
          description: "test",
          source: "test",
          filePath: "/tmp/versioned",
          baseDir: "/tmp",
          disableModelInvocation: false,
        },
        frontmatter: {},
        metadata: {
          requires: { bins: ["fakebin"] },
          install: [
            {
              id: "brew",
              kind: "brew",
              formula: "fakebin",
              bins: ["fakebin"],
              versionCommand: ["fakebin", "--version"],
              versionRegex: "fakebin (?<version>[0-9.]+)",
              minVersion: "1.0.0",
              recommendedVersion: "1.2.0",
            },
          ],
        },
      };

      const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });

      expect(report.skills[0]?.install[0]?.toolVersions).toEqual([
        {
          bin: "fakebin",
          command: ["fakebin", "--version"],
          installed: true,
          version: "1.1.0",
          minVersion: "1.0.0",
          recommendedVersion: "1.2.0",
          satisfiesMinVersion: true,
          satisfiesRecommendedVersion: false,
        },
      ]);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("surfaces consumer display names separately from machine skill names", () => {
    const entry: SkillEntry = {
      skill: {
        name: "gog",
        description: "Google account access",
        source: "test",
        filePath: "/tmp/gog",
        baseDir: "/tmp",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {
        displayName: "Google Workspace",
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });

    expect(report.skills[0]?.name).toBe("gog");
    expect(report.skills[0]?.displayName).toBe("Google Workspace");
  });

  it("uses consumer display names for known shadowed workspace skill ids", () => {
    const entry: SkillEntry = {
      skill: {
        name: "wacli",
        description: "Legacy workspace WhatsApp skill",
        source: "openclaw-workspace",
        filePath: "/tmp/wacli",
        baseDir: "/tmp",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });

    expect(report.skills[0]?.name).toBe("wacli");
    expect(report.skills[0]?.displayName).toBe("WhatsApp");
  });
});
