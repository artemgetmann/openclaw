import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("consumer mcporter runtime contract", () => {
  it("keeps skill metadata and the packaged payload receipt pinned together", () => {
    const skill = fs.readFileSync(path.join(repoRoot, "skills/mcporter/SKILL.md"), "utf8");
    const helper = fs.readFileSync(
      path.join(repoRoot, "scripts/lib/consumer-mcporter-runtime.sh"),
      "utf8",
    );

    const version = skill.match(/"recommendedVersion": "([^"]+)"/)?.[1];
    const integrity = skill.match(/"integrity": "([^"]+)"/)?.[1];
    const license = skill.match(/"license": "([^"]+)"/)?.[1];
    expect(version).toBeTruthy();
    expect(integrity).toMatch(/^sha512-/);
    expect(license).toBe("MIT");
    expect(helper).toContain(`OPENCLAW_CONSUMER_MCPORTER_VERSION="${version}"`);
    expect(helper).toContain(`OPENCLAW_CONSUMER_MCPORTER_INTEGRITY="${integrity}"`);
    expect(helper).toContain(`OPENCLAW_CONSUMER_MCPORTER_LICENSE="${license}"`);
  });

  it("never installs mcporter globally or runs package lifecycle scripts", () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, "scripts/lib/consumer-mcporter-runtime.sh"),
      "utf8",
    );
    expect(helper).toContain("--ignore-scripts");
    expect(helper).toContain("@rolldown/binding-darwin-arm64");
    expect(helper).toContain("@rolldown/binding-darwin-x64");
    expect(helper).toContain("--package-lock=true");
    expect(helper).not.toMatch(/npm_bin.*(?:-g|--global)/);
  });
});
