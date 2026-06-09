import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("scripts/package-mac-app.sh consumer resources", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

  it("fails consumer packaging when the OpenClaw resource bundle or Jarvis icon is missing", () => {
    expect(script).toContain("consumer app resource bundle not found");
    expect(script).toContain("OpenClaw_OpenClaw.bundle/Jarvis.icns");
    expect(script).toContain("shipping without it crashes the packaged app");
  });
  it("packages consumer builds as foreground apps for first-run onboarding", () => {
    expect(script).toContain('[[ "$APP_VARIANT" == "consumer" ]]');
    expect(script).toContain("Set :LSUIElement false");
    expect(script).toContain("Stage Manager keep onboarding in the side strip");
  });
});
