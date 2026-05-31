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
    expect(script).toContain("--reuse-runtime");
    expect(script).toContain("--shell-only-fast");
    expect(script).toContain("package_rc_app_fast");
    expect(script).toContain("package_rc_app_notarized");
    expect(script).toContain("notarize_rc_app");
  });

  it("routes RC shell-only smoke mode through the existing fast runtime reuse path", () => {
    expect(script).toContain("REUSE_RUNTIME=0");
    expect(script).toContain("package_args+=(--reuse-runtime)");
    expect(script).toContain(
      '"$ROOT_DIR/scripts/package-consumer-mac-app-fast.sh" "${package_args[@]}"',
    );
    expect(script).toContain("dist/index.js missing; --reuse-runtime is unsafe");
    expect(script).toContain("--reuse-runtime/--shell-only-fast is only valid with --fast");
  });

  it("bounds AppleScript relaunch activation", () => {
    expect(script).toContain('source "$ROOT_DIR/scripts/lib/macos-activation.sh"');
    expect(script).toContain("OPENCLAW_MAC_APP_ACTIVATION_TIMEOUT_SECS=12");
    expect(script).toContain('openclaw_activate_macos_app "$RC_INSTALL_PATH" "$RC_BUNDLE_ID"');
    expect(script).not.toContain("/usr/bin/osascript <<EOF >/dev/null 2>&1 || true");
  });

  it("refuses debug TCC identity and avoids shared gateway mutation", () => {
    expect(script).toContain("OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY must be unset/false");
    expect(script).toContain("OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=0");
    expect(script).toContain("shared_gateway=untouched");
    expect(script).not.toContain("ai.openclaw.gateway install");
    expect(script).not.toContain("launchctl bootout");
  });
});

describe("macOS activation helper", () => {
  const helper = fs.readFileSync(path.join(root, "scripts", "lib", "macos-activation.sh"), "utf8");
  const openScript = fs.readFileSync(
    path.join(root, "scripts", "open-consumer-mac-app.sh"),
    "utf8",
  );

  it("kills hung osascript activation and prints manual recovery", () => {
    expect(helper).toContain("OPENCLAW_MAC_APP_ACTIVATION_TIMEOUT_SECS");
    expect(helper).toContain('/usr/bin/osascript "$script_path"');
    expect(helper).toContain("timed out after ${timeout_secs}s");
    expect(helper).toContain("Manual next command:");
    expect(helper).toContain('/bin/kill -9 "$osascript_pid"');
  });

  it("is used by the generic consumer app opener", () => {
    expect(openScript).toContain('source "$ROOT_DIR/scripts/lib/macos-activation.sh"');
    expect(openScript).toContain('openclaw_activate_macos_app "$APP_PATH" "$actual_bundle_id"');
    expect(openScript).not.toContain("/usr/bin/osascript <<EOF >/dev/null 2>&1 || true");
  });
});

describe("consumer runtime reuse guard", () => {
  const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");

  it("records and verifies a runtime input key before reusing a bundled runtime", () => {
    expect(packageScript).toContain("consumer_runtime_input_key()");
    expect(packageScript).toContain('hash_consumer_runtime_path "dist"');
    expect(packageScript).toContain('hash_consumer_runtime_path "package.json"');
    expect(packageScript).toContain('hash_consumer_runtime_path "pnpm-lock.yaml"');
    expect(packageScript).toContain('"runtimeInputKey":"${runtime_input_key}"');
    expect(packageScript).toContain("previous_runtime_input_key");
    expect(packageScript).toContain("runtime inputs changed; refusing smoke-only --reuse-runtime");
  });

  it("refuses runtime reuse when required runtime output or manifest metadata is missing", () => {
    expect(packageScript).toContain("dist/index.js missing; --reuse-runtime is unsafe");
    expect(packageScript).toContain("previous bundled runtime is missing manifest.json");
    expect(packageScript).toContain("manifest lacks runtimeInputKey");
    expect(packageScript).toContain(
      "OPENCLAW_CONSUMER_REUSE_RUNTIME is allowed only on the fast smoke packaging path",
    );
  });
});
