import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("consumer Sparkle release gates", () => {
  it("keeps package-mac-app Sparkle feed detection portable to macOS Bash 3.2", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

    expect(script).not.toContain("[[ -v SPARKLE_FEED_URL ]]");
    expect(script).toContain('if [[ "${SPARKLE_FEED_URL+x}" == x ]]');
    expect(script).toContain('SPARKLE_FEED_URL="${SPARKLE_FEED_URL}"');
  });

  it("keeps notarized consumer distribution blocked without a feed and production key", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
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

  it("pins Sparkle appcast payload URLs to the release tag", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const verifier = fs.readFileSync(
      path.join(root, "scripts", "verify-jarvis-release-assets.mjs"),
      "utf8",
    );

    expect(script).toContain("JARVIS_LATEST_RELEASE_DOWNLOAD_BASE");
    expect(script).toContain("jarvis_tagged_release_download_base");
    expect(script).toContain("jarvis_appcast_zip_public_url");
    expect(script).toContain("releases/download/%s");
    expect(script).toContain('SPARKLE_DOWNLOAD_URL_PREFIX="${zip_download_base}/"');
    expect(script).toContain('--zip-url "$(jarvis_appcast_zip_public_url)"');
    expect(script).not.toContain(
      'SPARKLE_DOWNLOAD_URL_PREFIX="${JARVIS_LATEST_RELEASE_DOWNLOAD_BASE}/"',
    );
    expect(verifier).toContain("defaultVersionedZipUrl");
    expect(verifier).toContain("releases/download/v${shortVersion}/Jarvis.zip");
    expect(verifier).not.toContain("DEFAULT_ZIP_URL");
  });

  it("documents and gates the post-app-build resume phase", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("--phase <full|post-app-build>");
    expect(script).toContain('PACKAGE_PHASE="full"');
    expect(script).toContain("--resume-after-app-build");
    expect(script).toContain("verify_resume_app_bundle");
    expect(script).toContain('if [[ "$PACKAGE_PHASE" == "full" ]]');
    expect(script).toContain("write_app_build_receipt");
    expect(script).toContain("Do not source this file");
    expect(readme).toContain("--phase post-app-build");
    expect(readme).toContain("resumes from the existing `dist/Jarvis.app`");
  });

  it("keeps notarization retry guidance focused on polling or retrying artifacts", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "notarize-mac-artifact.sh"), "utf8");
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("print_submit_retry_hint");
    expect(script).toContain("if notarytool printed a submission ID");
    expect(script).toContain("--poll <submission-id>");
    expect(script).toContain("retry the same artifact");
    expect(readme).toContain("HTTPClientError.deadlineExceeded");
    expect(readme).toContain("instead of rebuilding the app");
    expect(readme).toContain("Receipts and logs must not contain secrets");
  });
});
