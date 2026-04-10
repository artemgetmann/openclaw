import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const runResult = (script: string, env: NodeJS.ProcessEnv = {}) => {
  try {
    return { status: 0, stdout: run(script, env) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
};

describe("consumer packaging contract guard", () => {
  it("fails closed when no packaging contract is declared", () => {
    const result = runResult(
      `source scripts/lib/consumer-packaging-contract.sh; openclaw_consumer_packaging_contract_mode`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("consumer packaging contract missing");
  });

  it("accepts bundled packaging only when the bundled runtime is ready", () => {
    const stdout = run(
      `source scripts/lib/consumer-packaging-contract.sh; openclaw_consumer_packaging_contract_mode`,
      {
        OPENCLAW_CONSUMER_PACKAGING_CONTRACT: "bundled",
        OPENCLAW_CONSUMER_BUNDLED_RUNTIME_READY: "1",
      },
    );

    expect(stdout).toBe("bundled");
  });

  it("rejects bundled packaging when an external installer url is still wired in", () => {
    const result = runResult(
      `source scripts/lib/consumer-packaging-contract.sh; openclaw_consumer_packaging_contract_mode`,
      {
        OPENCLAW_CONSUMER_PACKAGING_CONTRACT: "bundled",
        OPENCLAW_CONSUMER_BUNDLED_RUNTIME_READY: "1",
        OPENCLAW_CONSUMER_INSTALLER_URL: "https://example.invalid/install-cli.sh",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not set OPENCLAW_CONSUMER_INSTALLER_URL");
  });

  it("allows the transitional legacy bootstrap only with explicit opt-in and installer url", () => {
    const stdout = run(
      `source scripts/lib/consumer-packaging-contract.sh; openclaw_consumer_packaging_contract_mode`,
      {
        OPENCLAW_CONSUMER_PACKAGING_CONTRACT: "legacy-bootstrap",
        OPENCLAW_CONSUMER_LEGACY_BOOTSTRAP_OK: "1",
        OPENCLAW_CONSUMER_INSTALLER_URL: "https://example.invalid/install-cli.sh",
      },
    );

    expect(stdout).toBe("legacy-bootstrap");
  });
});
