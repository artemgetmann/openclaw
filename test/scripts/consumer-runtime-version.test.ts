import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const verifierScript = path.join(root, "scripts", "verify-consumer-runtime-package-version.mjs");

function makeAppWithVersions(appVersion: string, runtimeVersion: string): string {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-version-"));
  const contentsPath = path.join(appPath, "Contents");
  const runtimePath = path.join(contentsPath, "Resources", "OpenClawRuntime", "openclaw");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(
    path.join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${appVersion}</string>
</dict>
</plist>
`,
  );
  fs.writeFileSync(
    path.join(runtimePath, "package.json"),
    JSON.stringify({ name: "openclaw", version: runtimeVersion, private: true }, null, 2),
  );
  return appPath;
}

describe("consumer bundled runtime version verification", () => {
  it("passes when the app version and bundled runtime package version match", () => {
    const appPath = makeAppWithVersions("2026.3.23", "2026.3.23");

    const output = execFileSync(process.execPath, [verifierScript, appPath], {
      encoding: "utf8",
    });

    expect(output.trim()).toBe("2026.3.23");
  });

  it("fails when the bundled runtime package version is stale", () => {
    const appPath = makeAppWithVersions("2026.3.23", "2026.3.16");

    const result = spawnSync(process.execPath, [verifierScript, appPath], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "consumer app version and bundled runtime package version differ",
    );
    expect(result.stderr).toContain("app_version=2026.3.23");
    expect(result.stderr).toContain("runtime_package_version=2026.3.16");
  });

  it("wires packaging refreshes through fresh, cached, and reused consumer runtime paths", () => {
    const packageScript = fs.readFileSync(path.join(root, "scripts", "package-mac-app.sh"), "utf8");
    const verifier = fs.readFileSync(
      path.join(root, "scripts", "verify-consumer-mac-app.sh"),
      "utf8",
    );

    expect(packageScript).toContain("sync_bundled_runtime_package_version()");
    expect(packageScript).toContain("refresh_bundled_runtime_metadata");
    expect(packageScript).toContain("sync_bundled_runtime_package_version");
    expect(packageScript).toContain("consumer-capabilities-manifest.mjs");
    expect(packageScript).toContain("capabilities.manifest.json");
    expect(packageScript).toContain("--fail-on-local-drift");
    expect(packageScript.match(/refresh_bundled_runtime_metadata/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(verifier).toContain("verify-consumer-runtime-package-version.mjs");
    expect(verifier).toContain("runtime_package_version=$runtime_package_version");
    expect(verifier).toContain("assert_capabilities_manifest_present");
  });
});
