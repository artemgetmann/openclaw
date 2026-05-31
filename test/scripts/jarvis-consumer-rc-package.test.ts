import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Jarvis Consumer RC packaging wrapper", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts", "package-jarvis-consumer-rc.sh"),
    "utf8",
  );

  it("pins the side-by-side RC app identity and install path", () => {
    expect(script).toContain('RC_INSTANCE_ID="jarvis-consumer-rc"');
    expect(script).toContain('RC_APP_NAME="Jarvis Consumer"');
    expect(script).toContain('RC_BUNDLE_ID="ai.openclaw.consumer.mac.consumer-rc"');
    expect(script).toContain('RC_INSTALL_PATH="/Applications/${RC_APP_BUNDLE_NAME}"');
    expect(script).toContain('[[ "$RC_INSTALL_PATH" != "/Applications/Jarvis.app" ]]');
  });

  it("keeps fast and notarized modes explicit", () => {
    expect(script).toContain("--fast");
    expect(script).toContain("--notarize");
    expect(script).toContain("package_rc_app_fast");
    expect(script).toContain("package_rc_app_notarized");
    expect(script).toContain("notarize_rc_app");
  });

  it("refuses debug TCC identity and avoids shared gateway mutation", () => {
    expect(script).toContain("OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY must be unset/false");
    expect(script).toContain("OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0");
    expect(script).toContain("shared_gateway=untouched");
    expect(script).not.toContain("ai.openclaw.gateway install");
    expect(script).not.toContain("launchctl bootout");
  });
});
