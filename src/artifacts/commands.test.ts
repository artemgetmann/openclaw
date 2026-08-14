import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
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

async function pdfPageCount(filePath: string): Promise<number> {
  // Parse the bytes with the repository's existing PDF reader. This proves the
  // in-repo writer emits a valid cross-reference table, not just a PDF header.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    disableWorker: true,
  }).promise;
  return document.numPages;
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

  it("creates PDF with the bundled creator", async () => {
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
    expect(await pdfPageCount(out)).toBeGreaterThan(1);
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
    expect(await pdfPageCount(out)).toBeGreaterThan(1);
  });

  it("makes progress when a repeated PDF table header fills a page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-tall-header-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(
      input,
      JSON.stringify({ sections: [{ table: { columns: ["W".repeat(3305)], rows: [["data"]] } }] }),
    );

    await createPdfCommand(input, { out });
    expect(await pdfPageCount(out)).toBeGreaterThan(1);
  });

  it("wraps wide PDF glyphs using measured font widths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pdf-wide-glyph-test-"));
    const input = path.join(dir, "brief.json");
    const out = path.join(dir, "brief.pdf");
    await fs.writeFile(input, JSON.stringify({ paragraphs: ["W".repeat(4000)] }));

    await createPdfCommand(input, { out });
    expect(await pdfPageCount(out)).toBeGreaterThan(1);
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
    expect(await pdfPageCount(out)).toBe(1);
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
    expect(await pdfPageCount(out)).toBe(1);
  });

  it.each([
    ["DOCX", "docx", createDocxCommand, "word/document.xml"],
    ["XLSX", "xlsx", createXlsxCommand, "xl/workbook.xml"],
  ] as const)(
    "creates editable %s with the bundled creator",
    async (_label, ext, command, requiredEntry) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-create-${ext}-test-`));
      const input = path.join(dir, "spec.json");
      const out = path.join(dir, `output.${ext}`);
      await fs.writeFile(input, JSON.stringify({ title: "Artifact", rows: [["A", 1]] }));
      const result = await command(input, { out });
      expect(result.path).toBe(out);
      const archive = await JSZip.loadAsync(await fs.readFile(out));
      expect(archive.file(requiredEntry)).not.toBeNull();
    },
  );

  it("preserves DOCX multiline text as Word line breaks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-docx-lines-test-"));
    const input = path.join(dir, "spec.json");
    const out = path.join(dir, "output.docx");
    await fs.writeFile(
      input,
      JSON.stringify({ paragraphs: ["Line one\nLine two\r\nLine three\rLine four"] }),
    );

    await createDocxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const document = await archive.file("word/document.xml")?.async("string");
    expect(document).toContain(
      '<w:t xml:space="preserve">Line one</w:t><w:br/><w:t xml:space="preserve">Line two</w:t><w:br/><w:t xml:space="preserve">Line three</w:t><w:br/><w:t xml:space="preserve">Line four</w:t>',
    );
  });

  it("encodes DOCX bullets with real Word list semantics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-docx-list-test-"));
    const input = path.join(dir, "spec.json");
    const out = path.join(dir, "output.docx");
    await fs.writeFile(input, JSON.stringify({ bullets: ["First", "Second"] }));

    await createDocxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const document = await archive.file("word/document.xml")?.async("string");
    const numbering = await archive.file("word/numbering.xml")?.async("string");
    const relationships = await archive.file("word/_rels/document.xml.rels")?.async("string");
    expect(document?.match(/<w:numPr>/g)).toHaveLength(2);
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
    expect(relationships).toContain('relationships/numbering" Target="numbering.xml"');
  });

  it.each([
    ["DOCX", "docx", createDocxCommand],
    ["XLSX", "xlsx", createXlsxCommand],
    ["PPTX", "pptx", createPptxCommand],
  ] as const)("rejects XML 1.0-invalid control characters in %s", async (_label, ext, command) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-create-${ext}-xml-test-`));
    const input = path.join(dir, "spec.json");
    const out = path.join(dir, `output.${ext}`);
    await fs.writeFile(input, JSON.stringify({ title: "Invalid\u0001text" }));

    await expect(command(input, { out })).rejects.toThrow(/XML 1\.0-invalid character.*U\+0001/u);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves formula-prefixed XLSX cells as formulas", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-xlsx-formula-test-"));
    const input = path.join(dir, "spec.json");
    const out = path.join(dir, "output.xlsx");
    await fs.writeFile(input, JSON.stringify({ rows: [[1], [2], ["=SUM(A1:A2)"]] }));

    await createXlsxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const worksheet = await archive.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(worksheet).toContain('<c r="A3"><f>SUM(A1:A2)</f></c>');
  });

  it("keeps duplicate XLSX sheet names unique", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-xlsx-names-test-"));
    const input = path.join(dir, "book.json");
    const out = path.join(dir, "book.xlsx");
    await fs.writeFile(
      input,
      JSON.stringify({ sheets: [{ name: "Same" }, { name: "Same" }, { name: "same" }] }),
    );

    await createXlsxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const workbook = await archive.file("xl/workbook.xml")?.async("string");
    expect(
      Array.from(workbook?.matchAll(/<sheet name="([^"]+)"/g) ?? [], (match) => match[1]),
    ).toEqual(["Same", "Same1", "same2"]);
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

  it("creates editable PPTX with the bundled creator", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(input, JSON.stringify({ title: "Deck", slides: [{ title: "One" }] }));

    const result = await createPptxCommand(input, { out });
    expect(result.path).toBe(out);
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    expect(archive.file("ppt/presentation.xml")).not.toBeNull();
    expect(archive.file("ppt/slides/slide1.xml")).not.toBeNull();
  });

  it("preserves scalar PPTX slides as titles", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-scalar-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(input, JSON.stringify({ slides: ["Keep me"] }));

    await createPptxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const slide = await archive.file("ppt/slides/slide1.xml")?.async("string");
    expect(slide).toContain("Keep me");
  });

  it("keeps a 20-row PPTX table inside its frame with visible text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-pptx-table-test-"));
    const input = path.join(dir, "deck.json");
    const out = path.join(dir, "deck.pptx");
    await fs.writeFile(
      input,
      JSON.stringify({
        slides: [
          {
            title: "Rows",
            table: { rows: Array.from({ length: 20 }, (_, index) => [`Row ${index + 1}`]) },
          },
        ],
      }),
    );

    await createPptxCommand(input, { out });
    const archive = await JSZip.loadAsync(await fs.readFile(out));
    const slide = await archive.file("ppt/slides/slide1.xml")?.async("string");
    const rowHeights = Array.from(slide?.matchAll(/<a:tr h="(\d+)">/g) ?? [], (match) =>
      Number(match[1]),
    );
    expect(rowHeights).toHaveLength(20);
    expect(rowHeights.reduce((total, height) => total + height, 0)).toBeLessThanOrEqual(4_191_000);
    expect(slide).toContain("Row 20");
    expect(slide).toMatch(
      /<a:rPr[^>]*><a:solidFill><a:srgbClr val="1F2937"\/><\/a:solidFill><\/a:rPr>/,
    );
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
