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

  it("keeps Sparkle release ZIPs free of macOS metadata sidecars", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const verifier = fs.readFileSync(
      path.join(root, "scripts", "verify-jarvis-release-assets.mjs"),
      "utf8",
    );

    expect(script).toContain("assert_sparkle_zip_has_no_macos_metadata");
    expect(script).toContain("ditto -c -k --norsrc --keepParent");
    expect(script).toContain("Sparkle ZIP contains macOS metadata entries");
    expect(script).toContain('ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"');
    expect(verifier).toContain("verifyZipHasNoMacOSMetadata");
    expect(verifier).toContain("zip_contents_ok");
    expect(verifier).toContain('parts.includes("__MACOSX")');
    expect(verifier).toContain('part.startsWith("._")');
  });

  it("documents and gates the post-app-build resume phase", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("build-app-only|submit-app-notarization|poll-app-notarization");
    expect(script).toContain('PACKAGE_PHASE="full"');
    expect(script).toContain("--resume-after-app-build");
    expect(script).toContain("verify_resume_app_bundle");
    expect(script).toContain(
      'if [[ "$PACKAGE_PHASE" == "full" || "$PACKAGE_PHASE" == "local-proof" || "$PACKAGE_PHASE" == "build-app-only" || "$PACKAGE_PHASE" == "trusted-ring-fast" ]]',
    );
    expect(script).toContain("write_app_build_receipt");
    expect(script).toContain("Do not source this file");
    expect(readme).toContain("--phase post-app-build");
    expect(readme).toContain("resumes from the existing `dist/Jarvis.app`");
  });

  it("adds local proof packaging that exits after app verification and metadata", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("--local-proof");
    expect(script).toContain('PACKAGE_PHASE="local-proof"');
    expect(script).toContain("full|local-proof|post-app-build|build-app-only");
    expect(script).toContain('if [[ "$PACKAGE_PHASE" == "local-proof" ]]');
    expect(script).toContain("OPENCLAW_CONSUMER_FAST_PACKAGING=1");
    expect(script).toContain("OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE=1");
    expect(script).toContain("Jarvis local proof app bundle ready");
    expect(script).toContain("app_build_receipt=$(app_build_receipt_path)");
    expect(script).toContain(
      "local-proof stops before notarization, DMG, ZIP, appcast, publish, install, launchd, and shared runtime changes",
    );
    expect(script).toContain(
      'if [[ "$PACKAGE_PHASE" == "full" || "$PACKAGE_PHASE" == "local-proof" || "$PACKAGE_PHASE" == "build-app-only" || "$PACKAGE_PHASE" == "trusted-ring-fast" ]]',
    );

    expect(readme).toContain("bash scripts/package-openclaw-mac-dist.sh --local-proof");
    expect(readme).toContain("It does not create `Jarvis.dmg`, `Jarvis.zip`, or");
    expect(readme).toContain("`jarvis-appcast.xml`; it also does not notarize");
  });

  it("adds narrow resumable release phases with saved manifest and receipts", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("RELEASE_MANIFEST_PATH");
    expect(script).toContain("dist/jarvis-release-manifest.env");
    expect(script).toContain("app_notary_receipt_path");
    expect(script).toContain("dmg_notary_receipt_path");
    expect(script).toContain("submit_app_notarization_only");
    expect(script).toContain("poll_app_notarization_only");
    expect(script).toContain("submit_dmg_notarization_only");
    expect(script).toContain("poll_dmg_notarization_only");
    expect(script).toContain("publish-assets-only");
    expect(script).toContain("verify-public-assets-only");
    expect(script).toContain("require_notarized_manifest_before_publish");
    expect(script).toContain("require_app_notarized_manifest");
    expect(script).toContain("JARVIS_DMG_SHA256");
    expect(script).toContain("JARVIS_ZIP_SIZE_BYTES");
    expect(script).toContain("JARVIS_APPCAST_SHA256");
    expect(script).toContain("openclaw_build_run_root");
    expect(script).toContain("require_clean_git_for_release_build");

    expect(readme).toContain("bash scripts/package-openclaw-mac-dist.sh --phase build-app-only");
    expect(readme).toContain(
      "bash scripts/package-openclaw-mac-dist.sh --phase poll-app-notarization",
    );
    expect(readme).toContain(
      "bash scripts/package-openclaw-mac-dist.sh --phase poll-dmg-notarization",
    );
    expect(readme).toContain("--phase publish-assets-only");
    expect(readme).toContain("--phase verify-public-assets-only");
    expect(readme).toContain("bash scripts/package-openclaw-mac-dist.sh --trusted-ring-fast");
  });

  it("keeps trusted-ring packaging out of notarization and public release work", () => {
    const script = fs.readFileSync(
      path.join(root, "scripts", "package-openclaw-mac-dist.sh"),
      "utf8",
    );

    expect(script).toContain("--trusted-ring-fast");
    expect(script).toContain('PACKAGE_PHASE="trusted-ring-fast"');
    expect(script).toContain("SKIP_NOTARIZE=1");
    expect(script).toContain('SKIP_DSYM="${SKIP_DSYM:-1}"');
    expect(script).toContain("PUBLISH_RELEASE_ASSETS=0");
    expect(script).toContain("ALLOW_DEFAULT_SPARKLE_KEY_FOR_CONSUMER_SMOKE");
    expect(script).toContain("OPENCLAW_CONSUMER_FAST_PACKAGING=1");
    expect(script).toContain("OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE=1");
    expect(script).toContain(
      'OPENCLAW_CONSUMER_FAST_PACKAGING="$OPENCLAW_CONSUMER_FAST_PACKAGING"',
    );
    expect(script).toContain(
      'OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE="$OPENCLAW_CONSUMER_CLEAN_GIT_RUNTIME_CACHE"',
    );
    expect(script).toContain("full|local-proof|build-app-only|post-app-build|trusted-ring-fast");
  });

  it("keeps trusted-ring runtime cache keys stable across equivalent rebuilds", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

    expect(script).toContain("consumer_clean_git_runtime_input_key");
    expect(script).toContain("clean-git-runtime-cache-v1");
    expect(script).toContain("clean tracked worktree");
    expect(script).toContain("hash_consumer_build_info_stable_fields");
    expect(script).toContain("builtAt, which changes on every JS build");
    expect(script).toContain("-o -name '*.release.env'");
    expect(script).toContain("-o -name 'jarvis-release-manifest.env'");
    expect(script).toContain("-o -path 'dist/build-info.json'");
    expect(script).toContain("refresh_bundled_runtime_build_info");
    expect(script).toContain('cache_key="$runtime_input_key"');
  });

  it("keeps notarization retry guidance focused on polling or retrying artifacts", () => {
    const script = fs.readFileSync(path.join(root, "scripts", "notarize-mac-artifact.sh"), "utf8");
    const readme = fs.readFileSync(path.join(root, "apps", "macos", "README.md"), "utf8");

    expect(script).toContain("print_submit_retry_hint");
    expect(script).toContain("notarytool returned submission ID");
    expect(script).toContain("--poll <submission-id>");
    expect(script).toContain("NOTARY_STATUS");
    expect(script).toContain("run_notary_submit --wait");
    expect(script).toContain("--output-format json");
    expect(script).toContain("retry the same artifact");
    expect(readme).toContain("HTTPClientError.deadlineExceeded");
    expect(readme).toContain("instead of rebuilding the app");
    expect(readme).toContain("Receipts and logs must not contain secrets");
  });
});
