import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts/relaunch-consumer-mac-ui-smoke.sh");

describe("scripts/relaunch-consumer-mac-ui-smoke.sh", () => {
  it("seeds Jarvis backend config for activation smoke without echoing the token", () => {
    const script = fs.readFileSync(scriptPath, "utf8");

    expect(script).toContain('seed_jarvis_backend_config "$CONFIG_PATH"');
    expect(script).toContain(".baseUrl = $baseUrl");
    expect(script).toContain(".accessToken = $accessToken");
    expect(script).toContain("backend_config_seeded=true");
    expect(script).toContain(
      '"$CONSUMER_STEP" == "accountActivation" || "$CONSUMER_STEP" == "telegram" || "$CONSUMER_STEP" == "telegramGroup"',
    );
    expect(script).toContain(
      'BACKEND_API_TOKEN="${JARVIS_BACKEND_ACCESS_TOKEN:-${JARVIS_BACKEND_API_TOKEN:-}}"',
    );

    const echoLines = script
      .split("\n")
      .filter((line) => /^\s*echo\b/.test(line) && /\$[{]?BACKEND_API_TOKEN[}]?/.test(line));

    expect(echoLines).toEqual([]);
  });

  it("keeps backend credentials out of the generated debug app plist", () => {
    const script = fs.readFileSync(scriptPath, "utf8");
    const wrapperFunction = script.match(/write_debug_app_wrapper\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(wrapperFunction).not.toContain("JARVIS_BACKEND_API_TOKEN");
    expect(wrapperFunction).not.toContain("JARVIS_BACKEND_ACCESS_TOKEN");
    expect(wrapperFunction).not.toContain("BACKEND_API_TOKEN");
  });
});
