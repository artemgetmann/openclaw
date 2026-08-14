import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
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

  it("creates PDF with the bundled Node dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify({ title: "Brief", sections: [] }));

    const result = await createPdfCommand(input, { out });
    expect(result.path).toBe(out);
    expect((await fs.readFile(out)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects unsupported PDF text instead of silently corrupting it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-unicode-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify({ title: "Привет 世界 👋" }));

    await expect(createPdfCommand(input, { out })).rejects.toThrow(/unsupported character/);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a PDF with aligned table rows and wrapped cells", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-table-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({
        sections: [
          {
            table: {
              columns: ["Name", "Notes"],
              rows: [["Alpha", "A long table cell that must wrap while its row remains aligned"]],
            },
          },
        ],
      }),
    );

    await createPdfCommand(input, { out });
    expect((await fs.readFile(out)).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await fs.stat(out)).size).toBeGreaterThan(800);
  });

  it("splits a PDF table row that is taller than one page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-tall-row-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({
        sections: [{ table: { columns: ["Notes"], rows: [["long ".repeat(2500)]] } }],
      }),
    );

    await createPdfCommand(input, { out });
    const pdf = await PDFDocument.load(await fs.readFile(out));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("paginates a headed PDF table without losing the header route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-table-pages-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({
        sections: [
          {
            table: {
              columns: ["Name", "Value"],
              rows: Array.from({ length: 100 }, () => ["A", 1]),
            },
          },
        ],
      }),
    );

    await createPdfCommand(input, { out });
    const pdf = await PDFDocument.load(await fs.readFile(out));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("wraps wide PDF glyphs using measured font widths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-wide-glyph-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify({ paragraphs: ["W".repeat(4000)] }));

    await createPdfCommand(input, { out });
    const pdf = await PDFDocument.load(await fs.readFile(out));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it.each([
    ["scalar section", { sections: ["Keep me"] }],
    ["long token", { paragraphs: ["x".repeat(500)] }],
    ["empty spec", {}],
    ["empty table", { sections: [{ table: { rows: [] } }] }],
    ["control whitespace", { paragraphs: ["Line one\nLine two\tTabbed"] }],
  ])("creates a nonblank PDF for %s input", async (_label, spec) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-edge-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify(spec));

    await createPdfCommand(input, { out });
    expect((await fs.stat(out)).size).toBeGreaterThan(500);
  });

  it("does not paginate empty PDF paragraphs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-empty-lines-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({ paragraphs: Array.from({ length: 1000 }, () => " \t\n") }),
    );

    await createPdfCommand(input, { out });
    const pdf = await PDFDocument.load(await fs.readFile(out));
    expect(pdf.getPageCount()).toBe(1);
  });

  it("does not paginate empty PDF sections", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-create-pdf-empty-sections-test-"),
    );
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({ sections: Array.from({ length: 100 }, () => ({})) }),
    );

    await createPdfCommand(input, { out });
    const pdf = await PDFDocument.load(await fs.readFile(out));
    expect(pdf.getPageCount()).toBe(1);
  });

  it.each([
    ["DOCX", "docx", createDocxCommand],
    ["XLSX", "xlsx", createXlsxCommand],
  ] as const)(
    "creates editable %s with bundled Node dependencies",
    async (_label, ext, command) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-create-${ext}-test-`));
      const input = path.join(dir, "spec.json");
      const out = path.join(dir, `output.${ext}`);
      await fs.writeFile(input, JSON.stringify({ title: "Artifact", rows: [["A", 1]] }));
      const result = await command(input, { out });
      expect(result.path).toBe(out);
      expect((await fs.readFile(out)).subarray(0, 2).toString()).toBe("PK");
    },
  );

  it("preserves formula-prefixed XLSX cells as formulas", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-xlsx-formula-test-"));
    const input = path.join(dir, "spec.json");
    const out = path.join(dir, "output.xlsx");
    await fs.writeFile(input, JSON.stringify({ rows: [[1], [2], ["=SUM(A1:A2)"]] }));

    await createXlsxCommand(input, { out });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(out);
    expect(workbook.getWorksheet(1)?.getCell("A3").value).toEqual({ formula: "SUM(A1:A2)" });
  });

  it("rejects invalid PDF spec JSON before creating output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-json-test-"));
    const input = path.join(dir, "brief.json");
    await fs.writeFile(input, "{ nope");
    await expect(createPdfCommand(input)).rejects.toThrow(/valid JSON/i);
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

  it("places Office output in the requested output directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-office-out-dir-test-"));
    const input = path.join(dir, "brief.docx");
    const outDir = path.join(dir, "exports");
    await fs.writeFile(input, "docx");
    const runner: ArtifactCommandRunner = vi.fn(async (argv: string[]) => {
      const conversionDir = String(argv[argv.indexOf("--outdir") + 1]);
      await fs.writeFile(path.join(conversionDir, "brief.pdf"), "converted");
      return okSpawnResult();
    });
    const result = await docxToPdfCommand(
      input,
      { outDir },
      { runtime: fakeRuntime({ soffice: "/bin/soffice" }), runner },
    );
    expect(result.path).toBe(path.join(outDir, "brief.pdf"));
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("converted");
  });

  it("creates editable PPTX with the bundled Node dependency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(input, JSON.stringify({ title: "Deck", slides: [{ title: "One" }] }));

    const result = await createPptxCommand(input, { out });
    expect(result.path).toBe(out);
    expect((await fs.readFile(out)).subarray(0, 2).toString()).toBe("PK");
  });

  it("preserves scalar PPTX slides as titles", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-scalar-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(input, JSON.stringify({ slides: ["Keep me"] }));

    await createPptxCommand(input, { out });
    const archive = await fs.readFile(out);
    expect(archive.subarray(0, 2).toString()).toBe("PK");
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
