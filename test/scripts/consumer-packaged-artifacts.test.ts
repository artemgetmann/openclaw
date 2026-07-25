import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const verifier = path.join(root, "scripts", "verify-consumer-packaged-artifacts.sh");
const materializer = path.join(root, "scripts", "materialize-consumer-packaged-artifacts.sh");

function makeFixture() {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-artifact-"));
  const appPath = path.join(packageRoot, "native", "Fixture.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Fixture");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const sourceRepo = "https://example.test/open-computer-use.git";
  const sourceRef = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", "/bin/echo"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);

  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.copyFileSync("/bin/echo", executablePath);
  fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(
    path.join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.fixture</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>
`,
  );
  fs.writeFileSync(path.join(resourcesPath, "LICENSE.txt"), "MIT License\n");
  fs.writeFileSync(
    path.join(resourcesPath, "receipt.json"),
    `${JSON.stringify({ format: 1, sourceRepo, sourceRef })}\n`,
  );

  const manifestPath = path.join(packageRoot, "capabilities.manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      format: 1,
      packagedArtifacts: [
        {
          skillName: "fixture",
          id: "fixture",
          kind: "macos-app",
          requirement: "consumer-release",
          path: "native/Fixture.app",
          executable: "Contents/MacOS/Fixture",
          bundleIdentifier: "test.fixture",
          version: "1.2.3",
          architectures,
          sourceRepo,
          sourceRef,
          licensePath: "Contents/Resources/LICENSE.txt",
          receiptPath: "Contents/Resources/receipt.json",
        },
      ],
    })}\n`,
  );
  return { appPath, manifestPath, packageRoot };
}

describe.skipIf(process.platform !== "darwin")(
  "scripts/verify-consumer-packaged-artifacts.sh",
  () => {
    it("accepts a complete declared macOS app artifact", () => {
      const fixture = makeFixture();
      const result = spawnSync("bash", [verifier, fixture.manifestPath, fixture.packageRoot], {
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("fails closed when the declared license notice is absent", () => {
      const fixture = makeFixture();
      fs.rmSync(path.join(fixture.appPath, "Contents", "Resources", "LICENSE.txt"));
      const result = spawnSync("bash", [verifier, fixture.manifestPath, fixture.packageRoot], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing its license notice");
    });

    it("fails closed when the source receipt names a different repository", () => {
      const fixture = makeFixture();
      fs.writeFileSync(
        path.join(fixture.appPath, "Contents", "Resources", "receipt.json"),
        `${JSON.stringify({
          format: 1,
          sourceRepo: "https://example.test/wrong.git",
          sourceRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        })}\n`,
      );
      const result = spawnSync("bash", [verifier, fixture.manifestPath, fixture.packageRoot], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stale packaged artifact receipt");
    });
  },
);

describe("scripts/materialize-consumer-packaged-artifacts.sh", () => {
  it("uses a cleanup-managed isolated build run instead of a shared mutable checkout", () => {
    const script = fs.readFileSync(materializer, "utf8");

    expect(script).toContain('openclaw_build_run_root "consumer-packaged-artifacts"');
    expect(script).toContain("trap cleanup_build_run EXIT");
    expect(script).toContain('checkout_root="$BUILD_RUN_ROOT/');
    expect(script).not.toContain("open-computer-use-source");
  });
});
