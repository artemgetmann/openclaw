import { describe, expect, it } from "vitest";
import { detectDangerousExecCommand } from "./exec-dangerous-command-guard.js";

describe("detectDangerousExecCommand", () => {
  it("allows ordinary shell features in full mode", () => {
    expect(
      detectDangerousExecCommand(
        'bash -lc "printf ok | tr a-z A-Z > /tmp/openclaw-exec-proof.txt && cat /tmp/openclaw-exec-proof.txt"',
      ),
    ).toBeNull();
  });

  it("blocks sudo", () => {
    expect(detectDangerousExecCommand("sudo reboot")).toContain("sudo");
  });

  it("blocks broad rm -rf targets, even inside shell wrappers", () => {
    expect(detectDangerousExecCommand('bash -lc "rm -rf *"')).toContain("rm -rf");
  });

  it("blocks destructive psql mutations", () => {
    expect(
      detectDangerousExecCommand("psql -c 'DROP TABLE users;' postgres://localhost/test"),
    ).toContain("psql");
  });

  it("blocks shutdown and reboot commands", () => {
    expect(detectDangerousExecCommand("systemctl reboot")).toContain("shutdown");
  });
});
