import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePdfScale, resolveArtifactRuntime, resolveHtmlInputUrl } from "./runtime.js";

describe("artifact runtime", () => {
  it("defaults HTML-to-PDF scale to 1 and enforces Playwright scale bounds", () => {
    expect(normalizePdfScale(undefined)).toBe(1);
    expect(normalizePdfScale("0.5")).toBe(0.5);
    expect(normalizePdfScale(2)).toBe(2);
    expect(() => normalizePdfScale("0.09")).toThrow(/between 0.1 and 2/i);
    expect(() => normalizePdfScale("2.1")).toThrow(/between 0.1 and 2/i);
    expect(() => normalizePdfScale("nope")).toThrow(/positive number/i);
  });

  it("turns local HTML paths into file URLs and preserves web URLs", () => {
    expect(resolveHtmlInputUrl("https://example.com/a.html")).toBe("https://example.com/a.html");
    expect(resolveHtmlInputUrl("/tmp/demo.html")).toBe("file:///tmp/demo.html");
  });

  it("resolves artifact binaries from OPENCLAW_ARTIFACT_RUNTIME_DIR", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifact-runtime-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ["soffice", "pdftoppm", "pdfinfo", "python3"]) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n");
    }

    const runtime = resolveArtifactRuntime({
      OPENCLAW_ARTIFACT_RUNTIME_DIR: root,
      PATH: "",
      HOME: os.homedir(),
    } as NodeJS.ProcessEnv);

    expect(runtime.roots).toContain(root);
    expect(runtime.executables.soffice).toMatchObject({
      path: path.join(bin, "soffice"),
      source: "runtime",
    });
    expect(runtime.executables.pdftoppm.path).toBe(path.join(bin, "pdftoppm"));
    expect(runtime.executables.pdfinfo.path).toBe(path.join(bin, "pdfinfo"));
    expect(runtime.executables.python.path).toBe(path.join(bin, "python3"));
  });

  it("resolves Codex-style nested Python runtime bins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifact-runtime-nested-"));
    const pythonBin = path.join(root, "python", "bin");
    fs.mkdirSync(pythonBin, { recursive: true });
    fs.writeFileSync(path.join(pythonBin, "python3.12"), "#!/bin/sh\n");

    const runtime = resolveArtifactRuntime({
      OPENCLAW_ARTIFACT_RUNTIME_DIR: root,
      PATH: "",
      HOME: os.homedir(),
    } as NodeJS.ProcessEnv);

    expect(runtime.executables.python).toMatchObject({
      path: path.join(pythonBin, "python3.12"),
      source: "runtime",
    });
  });
});
