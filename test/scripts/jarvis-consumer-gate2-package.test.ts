import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Jarvis Consumer Gate2 packaging harness", () => {
  const packageScript = fs.readFileSync(
    path.join(root, "scripts", "package-jarvis-consumer-gate2.sh"),
    "utf8",
  );
  const collectorScript = fs.readFileSync(
    path.join(root, "scripts", "collect-jarvis-consumer-gate2-logs.sh"),
    "utf8",
  );

  it("pins the clean-user Gate2 identity and derived runtime selectors", () => {
    expect(packageScript).toContain('GATE2_INSTANCE_ID="jarvis-consumer-gate2"');
    expect(packageScript).toContain('GATE2_APP_NAME="Jarvis Consumer Gate2"');
    expect(packageScript).toContain('GATE2_BUNDLE_ID="ai.openclaw.consumer.mac.gate2"');
    expect(packageScript).toContain('GATE2_EXPECTED_PORT="25229"');
    expect(packageScript).toContain(
      'GATE2_EXPECTED_LABEL="ai.openclaw.consumer.jarvis-consumer-gate2.gateway"',
    );
  });

  it("stages to the clean user desktop instead of Applications and refuses an occupied port", () => {
    expect(packageScript).toContain('GATE2_USER="${JARVIS_GATE2_USER:-jarvistest}"');
    expect(packageScript).toContain('desktop="$home/Desktop"');
    expect(packageScript).toContain('staged_app="$desktop/$GATE2_APP_BUNDLE_NAME"');
    expect(packageScript).not.toContain("/Applications/Jarvis.app");
    expect(packageScript).not.toContain("/Applications/Jarvis Consumer.app");
    expect(packageScript).toContain('lsof -nP -iTCP:"$GATE2_EXPECTED_PORT" -sTCP:LISTEN');
    expect(packageScript).toContain("port $GATE2_EXPECTED_PORT is already owned");
  });

  it("preflights clean-user Desktop access before spending a package build", () => {
    expect(packageScript.indexOf("assert_stage_target_ready")).toBeLessThan(
      packageScript.indexOf("package_gate2_app_fast"),
    );
    expect(packageScript).toContain("target Desktop is not writable from $(whoami): $desktop");
  });

  it("copies a self-contained collector to Users Shared", () => {
    expect(packageScript).toContain(
      'GATE2_SHARED_DIR="${JARVIS_GATE2_SHARED_DIR:-/Users/Shared/JarvisConsumerGate2}"',
    );
    expect(packageScript).toContain("collect-jarvis-consumer-gate2-logs.sh");
    expect(collectorScript).toContain(
      'OUTPUT_ROOT="${JARVIS_GATE2_LOG_DIR:-/Users/Shared/jarvis-consumer-gate2-proof-${TIMESTAMP}}"',
    );
    expect(collectorScript).toContain('GATEWAY_PORT="25229"');
    expect(collectorScript).toContain(
      'GATEWAY_LABEL="ai.openclaw.consumer.jarvis-consumer-gate2.gateway"',
    );
    expect(collectorScript).toContain("openclaw.redacted.json");
  });
});
