import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("scripts/verify-consumer-mac-app.sh", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "verify-consumer-mac-app.sh"), "utf8");

  it("runs the packaged backend activation probe against bundled seeded defaults", () => {
    expect(script).toContain(
      'CONSUMER_SEEDED_DEFAULTS_PATH="$APP_PATH/Contents/Resources/consumer-seeded-defaults.json"',
    );
    expect(script).toContain("scripts/probe-consumer-release-activation.mjs");
    expect(script).toContain("JARVIS_BACKEND_ACTIVATION_PROBE_EMAIL");
    expect(script).toContain("JARVIS_BACKEND_ACTIVATION_PROBE_DEVICE_ID");
    expect(script).toContain("--app-version");
    expect(script).toContain("packaged Jarvis backend activation probe failed.");
  });
});
