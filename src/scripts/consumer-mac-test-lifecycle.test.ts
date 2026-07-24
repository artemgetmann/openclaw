import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("consumer macOS tester lifecycle shell contract", () => {
  it("keeps one replaceable tester while preserving production Jarvis", () => {
    const result = spawnSync("bash", ["scripts/test-consumer-mac-test-lifecycle.sh"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS: refuses a second tester without --replace");
    expect(result.stdout).toContain("PASS: replace retires exact previous tester app and gateway");
    expect(result.stdout).toContain("PASS: preserves production while retiring default debug app");
    expect(result.stdout).toContain("PASS: registry prevents gateway-only tester leaks");
    expect(result.stdout).toContain(
      "PASS: registry retires a running app after its bundle disappears",
    );
    expect(result.stdout).toContain("PASS: same-instance path transfer preserves its gateway");
    expect(result.stdout).toContain("PASS: serializes tester-slot acquisition");
    expect(result.stdout).toContain("PASS: reclaims a stale lock without concurrent ownership");
    expect(result.stdout).toContain("PASS: releases the slot lock when preparation fails");
    expect(result.stdout).toContain(
      "PASS: fails closed when the previous gateway cannot be quarantined",
    );
    expect(result.stdout).toContain(
      "PASS: fails closed when the tester registry cannot be written",
    );
    expect(result.stdout).toContain("PASS: holds the slot until the launched app is observable");
  });

  it("holds the tester slot through gateway refresh and app activation", () => {
    const script = fs.readFileSync(path.join(repoRoot, "scripts/open-consumer-mac-app.sh"), "utf8");
    const begin = script.indexOf("consumer_mac_test_begin_launch");
    const refresh = script.indexOf('if [[ "$REFRESH_GATEWAY" == "1" ]]');
    const activate = script.indexOf("openclaw_activate_macos_app");
    const release = script.lastIndexOf("consumer_mac_test_release_lock");

    expect(begin).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(begin);
    expect(activate).toBeGreaterThan(refresh);
    expect(release).toBeGreaterThan(activate);
    expect(script).toContain('APP_PATH="$(cd "$APP_PATH" && pwd -P)"');
  });
});
