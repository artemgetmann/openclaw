import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCli,
  runReleaseActivationProbe,
} from "../../scripts/probe-consumer-release-activation.mjs";

describe("scripts/probe-consumer-release-activation.mjs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-release-activation-probe-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeSeededDefaults(value: unknown) {
    const defaultsPath = path.join(root, "consumer-seeded-defaults.json");
    await fs.writeFile(defaultsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return defaultsPath;
  }

  it("posts packaged backend defaults to account login and returns only redacted status", async () => {
    const defaultsPath = await writeSeededDefaults({
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example.test/",
          accessToken: "backend-secret-token",
        },
      },
    });
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://jarvis.example.test/v1/account/login");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer backend-secret-token");
      expect(typeof init?.body).toBe("string");
      expect(JSON.parse(init?.body as string)).toEqual({
        email: "release-probe@example.com",
        deviceId: "release-probe-device",
        appVersion: "2026.3.15",
        platform: "macos",
      });
      return new Response(
        JSON.stringify({
          accountId: "acct_release_probe",
          email: "release-probe@example.com",
          accountAccessToken: "issued-account-token",
          license: {
            state: "trial_active",
            deviceId: "release-probe-device",
          },
        }),
        { status: 200, statusText: "OK" },
      );
    });

    const status = await runReleaseActivationProbe(
      {
        defaultsPath,
        email: "release-probe@example.com",
        deviceId: "release-probe-device",
        appVersion: "2026.3.15",
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      ok: true,
      httpStatus: 200,
      endpoint: "https://jarvis.example.test/v1/account/login",
      backendAccessToken: "[redacted]",
      accountAccessToken: "[redacted]",
      licenseState: "trial_active",
    });
    expect(JSON.stringify(status)).not.toContain("backend-secret-token");
    expect(JSON.stringify(status)).not.toContain("issued-account-token");
  });

  it("prints sanitized failure status when the server echoes bearer material", async () => {
    const backendToken = "server-echoed-backend-token";
    let capturedAuthorization: string | undefined;
    const server = http.createServer((request, response) => {
      capturedAuthorization = request.headers.authorization;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/account/login");
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: "unauthorized",
          message: `bad bearer ${backendToken}`,
          authorization: `Bearer ${backendToken}`,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    try {
      const defaultsPath = await writeSeededDefaults({
        jarvis: {
          backend: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            accessToken: backendToken,
          },
        },
      });
      const lines: string[] = [];

      const exitCode = await runCli(
        [
          defaultsPath,
          "--email",
          "release-probe@example.com",
          "--device-id",
          "release-probe-device",
        ],
        { stdout: (line: string) => lines.push(line) },
      );

      expect(exitCode).toBe(1);
      expect(capturedAuthorization).toBe(`Bearer ${backendToken}`);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"ok":false');
      expect(lines[0]).toContain('"httpStatus":401');
      expect(lines[0]).toContain("[redacted]");
      expect(lines[0]).not.toContain(backendToken);
      expect(lines[0]).not.toContain(`Bearer ${backendToken}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
