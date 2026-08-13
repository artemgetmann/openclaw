import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import {
  createPdfCommand,
  createDocxCommand,
  createPptxCommand,
  createXlsxCommand,
  docxToPdfCommand,
  htmlToPdfCommand,
  pptxToPdfCommand,
  renderPdfCommand,
  resolveArtifactOutputPath,
} from "./commands.js";
import type { ArtifactCommandRunner, ArtifactRuntimeResolution } from "./runtime.js";

const playwrightMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  newPage: vi.fn(),
  goto: vi.fn(),
  emulateMedia: vi.fn(),
  pdf: vi.fn(),
  close: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: playwrightMocks.launch,
  },
}));

function fakeRuntime(
  paths: Partial<Record<keyof ArtifactRuntimeResolution["executables"], string>>,
) {
  const executables = {} as ArtifactRuntimeResolution["executables"];
  for (const name of ["chrome", "node", "pdfinfo", "pdftoppm", "python", "soffice"] as const) {
    executables[name] = {
      name,
      path: paths[name] ?? null,
      source: paths[name] ? "env" : "unavailable",
    };
  }
  return { roots: [], executables };
}

function okSpawnResult(): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  };
}

describe("artifact commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playwrightMocks.pdf.mockResolvedValue(undefined);
    playwrightMocks.goto.mockResolvedValue(undefined);
    playwrightMocks.emulateMedia.mockResolvedValue(undefined);
    playwrightMocks.close.mockResolvedValue(undefined);
    playwrightMocks.newPage.mockResolvedValue({
      goto: playwrightMocks.goto,
      emulateMedia: playwrightMocks.emulateMedia,
      pdf: playwrightMocks.pdf,
    });
    playwrightMocks.launch.mockResolvedValue({
      newPage: playwrightMocks.newPage,
      close: playwrightMocks.close,
    });
  });

  it("resolves default output path next to the input", () => {
    expect(resolveArtifactOutputPath("/tmp/brief.docx", undefined, "pdf")).toBe("/tmp/brief.pdf");
    expect(resolveArtifactOutputPath("/tmp/brief.docx", "/tmp/out/final.pdf", "pdf")).toBe(
      "/tmp/out/final.pdf",
    );
  });

  it("runs ReportLab PDF creation through the artifact Python", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify({ title: "Brief", sections: [] }));

    const runner: ArtifactCommandRunner = vi.fn(async (_argv: string[], options) => {
      const payload = JSON.parse(String(options.input));
      await fs.writeFile(payload.outputPath, "pdf");
      return okSpawnResult();
    });

    const result = await createPdfCommand(
      input,
      { out },
      { runtime: fakeRuntime({ python: "/bin/python3" }), runner },
    );

    expect(runner).toHaveBeenCalledWith(
      ["/bin/python3", "-c", expect.stringContaining("from reportlab")],
      expect.objectContaining({
        timeoutMs: 120_000,
        input: expect.stringContaining('"title":"Brief"'),
      }),
    );
    expect(result.path).toBe(out);
    await expect(fs.readFile(out, "utf8")).resolves.toBe("pdf");
  });

  it.each([
    ["DOCX", "docx", createDocxCommand, "from docx import Document"],
    ["XLSX", "xlsx", createXlsxCommand, "from openpyxl import Workbook"],
  ] as const)(
    "creates editable %s through the artifact Python",
    async (_label, ext, command, marker) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-create-${ext}-test-`));
      const input = path.join(dir, "spec.json");
      const out = path.join(dir, `output.${ext}`);
      await fs.writeFile(input, JSON.stringify({ title: "Artifact", rows: [["A", 1]] }));
      const runner: ArtifactCommandRunner = vi.fn(async (_argv: string[], options) => {
        const payload = JSON.parse(String(options.input));
        await fs.writeFile(payload.outputPath, ext);
        return okSpawnResult();
      });
      const result = await command(
        input,
        { out },
        { runtime: fakeRuntime({ python: "/bin/python3" }), runner },
      );
      expect(runner).toHaveBeenCalledWith(
        ["/bin/python3", "-c", expect.stringContaining(marker)],
        expect.objectContaining({ input: expect.stringContaining('"title":"Artifact"') }),
      );
      expect(result.path).toBe(out);
    },
  );

  it("rejects invalid PDF spec JSON before running Python", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-json-test-"));
    const input = path.join(dir, "brief.json");
    await fs.writeFile(input, "{ nope");
    const runner: ArtifactCommandRunner = vi.fn();

    await expect(
      createPdfCommand(input, {}, { runtime: fakeRuntime({ python: "/bin/python3" }), runner }),
    ).rejects.toThrow(/valid JSON/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs LibreOffice DOCX-to-PDF conversion and moves to explicit output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docx-pdf-test-"));
    const input = path.join(dir, "brief.docx");
    const out = path.join(dir, "final.pdf");
    await fs.writeFile(input, "docx");

    const runner: ArtifactCommandRunner = vi.fn(async (argv: string[]) => {
      const outDir = argv[argv.indexOf("--outdir") + 1];
      await fs.writeFile(path.join(String(outDir), "brief.pdf"), "pdf");
      return okSpawnResult();
    });

    const result = await docxToPdfCommand(
      input,
      { out },
      { runtime: fakeRuntime({ soffice: "/bin/soffice" }), runner },
    );

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(["/bin/soffice", "--headless", "--convert-to", "pdf"]),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(result.path).toBe(out);
    await expect(fs.readFile(out, "utf8")).resolves.toBe("pdf");
  });

  it("does not overwrite a sibling PDF while converting Office output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docx-collision-test-"));
    const input = path.join(dir, "brief.docx");
    const sibling = path.join(dir, "brief.pdf");
    const out = path.join(dir, "brief-docx.pdf");
    await fs.writeFile(input, "docx");
    await fs.writeFile(sibling, "original");
    const runner: ArtifactCommandRunner = vi.fn(async (argv: string[]) => {
      const conversionDir = String(argv[argv.indexOf("--outdir") + 1]);
      await fs.writeFile(path.join(conversionDir, "brief.pdf"), "converted");
      return okSpawnResult();
    });
    await docxToPdfCommand(
      input,
      { out },
      { runtime: fakeRuntime({ soffice: "/bin/soffice" }), runner },
    );
    await expect(fs.readFile(sibling, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(out, "utf8")).resolves.toBe("converted");
  });

  it("creates editable PPTX through the artifact Python", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(input, JSON.stringify({ title: "Deck", slides: [{ title: "One" }] }));

    const runner: ArtifactCommandRunner = vi.fn(async (_argv: string[], options) => {
      const payload = JSON.parse(String(options.input));
      await fs.writeFile(payload.outputPath, "pptx");
      return okSpawnResult();
    });

    const result = await createPptxCommand(
      input,
      { out },
      { runtime: fakeRuntime({ python: "/bin/python3" }), runner },
    );

    expect(runner).toHaveBeenCalledWith(
      ["/bin/python3", "-c", expect.stringContaining("from pptx import Presentation")],
      expect.objectContaining({
        timeoutMs: 120_000,
        input: expect.stringContaining('"title":"Deck"'),
      }),
    );
    expect(result.path).toBe(out);
    await expect(fs.readFile(out, "utf8")).resolves.toBe("pptx");
  });

  it("runs LibreOffice PPTX-to-PDF conversion", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pptx-pdf-test-"));
    const input = path.join(dir, "deck.pptx");
    const out = path.join(dir, "deck.pdf");
    await fs.writeFile(input, "pptx");

    const runner: ArtifactCommandRunner = vi.fn(async (argv: string[]) => {
      const outDir = argv[argv.indexOf("--outdir") + 1];
      await fs.writeFile(path.join(String(outDir), "deck.pdf"), "pdf");
      return okSpawnResult();
    });

    const result = await pptxToPdfCommand(
      input,
      { out },
      { runtime: fakeRuntime({ soffice: "/bin/soffice" }), runner },
    );

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(["/bin/soffice", "--headless", "--convert-to", "pdf"]),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(result.path).toBe(out);
  });

  it("prints HTML slide decks with CSS page sizing preserved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-html-slide-pdf-test-"));
    const input = path.join(dir, "deck.html");
    const out = path.join(dir, "deck.pdf");
    await fs.writeFile(
      input,
      "<style>@page{size:16in 9in;margin:0}</style><section>Slide</section>",
    );

    const result = await htmlToPdfCommand(
      input,
      { out, preferCssPageSize: true },
      { runtime: fakeRuntime({ chrome: "/Applications/Chrome" }) },
    );

    expect(playwrightMocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: "/Applications/Chrome" }),
    );
    expect(playwrightMocks.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        path: out,
        scale: 1,
        printBackground: true,
        preferCSSPageSize: true,
      }),
    );
    expect(result.path).toBe(out);
  });

  it("runs Poppler PDF rendering and returns generated page paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-render-pdf-test-"));
    const input = path.join(dir, "brief.pdf");
    const outDir = path.join(dir, "rendered");
    await fs.writeFile(input, "pdf");

    const runner: ArtifactCommandRunner = vi.fn(async (argv: string[]) => {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(`${argv[3]}-1.png`, "png");
      return okSpawnResult();
    });

    const result = await renderPdfCommand(
      input,
      { outDir, prefix: "page" },
      { runtime: fakeRuntime({ pdftoppm: "/bin/pdftoppm" }), runner },
    );

    expect(runner).toHaveBeenCalledWith(
      ["/bin/pdftoppm", "-png", input, path.join(outDir, "page")],
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(result.paths).toEqual([path.join(outDir, "page-1.png")]);
  });
});
