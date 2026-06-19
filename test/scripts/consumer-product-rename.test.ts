import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("consumer product rename", () => {
  it("ships release artifacts as Jarvis while preserving script wiring", () => {
    const distScript = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );

    expect(distScript).toContain('APP_NAME="${APP_NAME:-Jarvis}"');
    expect(distScript).toContain(
      'EXPECTED_BUNDLE_ID="${BUNDLE_ID:-$(consumer_instance_release_bundle_id "$NORMALIZED_INSTANCE_ID")}"',
    );
    expect(distScript).toContain('EXPECTED_URL_SCHEME="${URL_SCHEME:-openclaw-consumer}"');
    expect(distScript).toContain("Usage: scripts/package-openclaw-mac-dist.sh");

    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");
    expect(packageScript).toContain('DEFAULT_APP_NAME="Jarvis"');
    expect(packageScript).toContain("Jarvis.icns");
    expect(packageScript).toContain("APP_ICON_BASENAME");
  });

  it("moves only the default release bundle identity to Jarvis", () => {
    const scriptPath = path.join(root, "scripts", "lib", "consumer-instance.sh");
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          `source "${scriptPath}"`,
          'consumer_instance_release_bundle_id ""',
          "printf '\\n'",
          'consumer_instance_release_bundle_id "rc"',
          "printf '\\n'",
          'consumer_instance_bundle_id ""',
        ].join("; "),
      ],
      { encoding: "utf8" },
    ).trimEnd();

    expect(output.split("\n")).toEqual([
      "ai.jarvis.mac",
      "ai.openclaw.consumer.mac.rc",
      "ai.openclaw.consumer.mac.debug",
    ]);
  });

  it("verifies that the packaged icon named by Info.plist exists", () => {
    const verifierScript = fs.readFileSync(
      path.join(root, "scripts", "verify-consumer-mac-app.sh"),
      "utf8",
    );

    expect(verifierScript).toContain("actual_icon_file");
    expect(verifierScript).toContain("bundled app icon missing for CFBundleIconFile");
    expect(verifierScript).toContain("icon_file=$actual_icon_file");
  });

  it("keeps the old consumer distribution command as a compatibility wrapper", () => {
    const wrapperScript = fs.readFileSync(
      path.join(root, "scripts", "package-consumer-mac-dist.sh"),
      "utf8",
    );

    expect(wrapperScript).toContain("Compatibility wrapper");
    expect(wrapperScript).toContain("scripts/package-openclaw-mac-dist.sh");
    expect(wrapperScript).toContain('exec "$ROOT_DIR/scripts/package-openclaw-mac-dist.sh" "$@"');
  });

  it("keeps the release smoke pointed at the renamed app bundle", () => {
    const smokeScript = fs.readFileSync(
      path.join(root, "scripts", "smoke-consumer-fresh-user-mac-app.sh"),
      "utf8",
    );

    expect(smokeScript).toContain(
      'DEFAULT_DMG="/Users/user/Programming_Projects/openclaw/dist/consumer-handoff/Jarvis.dmg"',
    );
    expect(smokeScript).toContain('APP_PATH="$ROOT_DIR/dist/Jarvis.app"');
    expect(smokeScript).toContain(
      'if [[ "$DISPLAY_NAME" != "Jarvis" || "$VARIANT" != "consumer" ]]',
    );
    expect(smokeScript).toContain('WINDOW_TITLES" != *"Welcome to Jarvis"*');
    expect(smokeScript).toContain("running_same_bundle_pids");
  });
});
