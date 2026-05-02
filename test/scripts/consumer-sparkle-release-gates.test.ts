import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("consumer Sparkle release gates", () => {
  it("keeps notarized consumer distribution blocked without a feed and production key", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-consumer-mac-dist.sh"),
      "utf8",
    );

    expect(script).toContain("consumer_sparkle_release_gate");
    expect(script).toContain('if [[ "$NOTARIZE" != "1" ]]');
    expect(script).toContain("notarized consumer packaging requires SPARKLE_FEED_URL");
    expect(script).toContain(
      "consumer release packaging must not use the generic OpenClaw appcast",
    );
    expect(script).toContain("notarized consumer packaging requires a consumer Sparkle public key");
    expect(script).toContain("ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE");
  });

  it("adds an explicit strict release verification mode", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "verify-consumer-mac-app.sh"),
      "utf8",
    );

    expect(script).toContain("--release");
    expect(script).toContain("OPENCLAW_CONSUMER_VERIFY_RELEASE");
    expect(script).toContain("release verification requires a Developer ID Application signature");
    expect(script).toContain("release verification requires a nonblank Sparkle feed URL");
    expect(script).toContain("SPARKLE_EXPECTED_PUBLIC_ED_KEY");
    expect(script).toContain("release verification requires Gatekeeper acceptance");
  });

  it("does not write the root appcast for named consumer artifacts by default", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "make_appcast.sh"), "utf8");

    expect(script).toContain("SPARKLE_APP_NAME");
    expect(script).toContain("SPARKLE_APPCAST_OUTPUT");
    expect(script).toContain('if [[ "$APP_NAME" == "OpenClaw" ]]');
    expect(script).toContain('APPCAST_OUTPUT="$ZIP_DIR/appcast.xml"');
    expect(script).toContain("SPARKLE_RELEASE_VERSION");
  });
});
