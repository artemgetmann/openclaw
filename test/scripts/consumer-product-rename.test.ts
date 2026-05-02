import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("consumer product rename", () => {
  it("ships release artifacts as OpenClaw while preserving consumer identity", () => {
    const distScript = fs.readFileSync(
      path.join(root, "scripts", "package-consumer-mac-dist.sh"),
      "utf8",
    );

    expect(distScript).toContain('APP_NAME="${APP_NAME:-OpenClaw}"');
    expect(distScript).toContain(
      'EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_release_bundle_id "$NORMALIZED_INSTANCE_ID")}"',
    );
    expect(distScript).toContain('EXPECTED_URL_SCHEME="${URL_SCHEME:-openclaw-consumer}"');

    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");
    expect(packageScript).toContain('APP_NAME="${APP_NAME:-OpenClaw}"');
  });

  it("keeps the release smoke pointed at the renamed app bundle", () => {
    const smokeScript = fs.readFileSync(
      path.join(root, "scripts", "smoke-consumer-fresh-user-mac-app.sh"),
      "utf8",
    );

    expect(smokeScript).toContain(
      'DEFAULT_DMG="/Users/user/Programming_Projects/openclaw/OpenClaw.dmg"',
    );
    expect(smokeScript).toContain('APP_PATH="$ROOT_DIR/dist/OpenClaw.app"');
    expect(smokeScript).toContain(
      'if [[ "$DISPLAY_NAME" != "OpenClaw" || "$VARIANT" != "consumer" ]]',
    );
    expect(smokeScript).toContain("running_same_bundle_pids");
  });
});
