import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultArtifactCommandRunner,
  normalizePdfScale,
  requireArtifactExecutable,
  resolveArtifactRuntime,
  resolveHtmlInputUrl,
  type ArtifactCommandRunner,
  type ArtifactRuntimeResolution,
} from "./runtime.js";

export type ArtifactCommandDeps = {
  runner?: ArtifactCommandRunner;
  runtime?: ArtifactRuntimeResolution;
};

export type ArtifactFileResult = {
  ok: true;
  path: string;
  details?: Record<string, unknown>;
};

// Keep the ReportLab renderer inline so packaged OpenClaw does not need to
// locate a separate helper asset before it can create a basic PDF.
const REPORTLAB_CREATE_PDF_SCRIPT = String.raw`
import json
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    ListFlowable,
    ListItem,
)


def as_text(value):
    if value is None:
        return ""
    return str(value)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def paragraph_cell(value, style):
    return Paragraph(as_text(value), style)


payload = json.load(sys.stdin)
spec = payload.get("spec") or {}
output_path = payload["outputPath"]

styles = getSampleStyleSheet()
# Callouts give agents a safe way to emphasize a decision or warning without
# inventing custom layout primitives in every generated document.
styles.add(
    ParagraphStyle(
        name="Callout",
        parent=styles["BodyText"],
        backColor=colors.HexColor("#F2F5F7"),
        borderColor=colors.HexColor("#CBD5E1"),
        borderPadding=8,
        leading=14,
        spaceBefore=6,
        spaceAfter=10,
    )
)

doc = SimpleDocTemplate(
    output_path,
    pagesize=letter,
    rightMargin=0.7 * inch,
    leftMargin=0.7 * inch,
    topMargin=0.7 * inch,
    bottomMargin=0.7 * inch,
)
story = []

title = as_text(spec.get("title")).strip()
if title:
    story.append(Paragraph(title, styles["Title"]))
    story.append(Spacer(1, 0.12 * inch))

subtitle = as_text(spec.get("subtitle")).strip()
if subtitle:
    story.append(Paragraph(subtitle, styles["BodyText"]))
    story.append(Spacer(1, 0.18 * inch))

sections = as_list(spec.get("sections"))
if not sections:
    # Allow tiny specs with only top-level paragraphs/bullets for quick notes.
    sections = [{"paragraphs": as_list(spec.get("paragraphs")), "bullets": as_list(spec.get("bullets"))}]

for section in sections:
    if not isinstance(section, dict):
        section = {"paragraphs": [section]}

    heading = as_text(section.get("heading")).strip()
    if heading:
        story.append(Paragraph(heading, styles["Heading2"]))

    for paragraph in as_list(section.get("paragraphs")):
        text = as_text(paragraph).strip()
        if text:
            story.append(Paragraph(text, styles["BodyText"]))
            story.append(Spacer(1, 0.08 * inch))

    bullets = [as_text(item).strip() for item in as_list(section.get("bullets")) if as_text(item).strip()]
    if bullets:
        story.append(
            ListFlowable(
                [ListItem(Paragraph(item, styles["BodyText"])) for item in bullets],
                bulletType="bullet",
                leftIndent=18,
            )
        )
        story.append(Spacer(1, 0.1 * inch))

    callout = section.get("callout")
    if callout:
        story.append(Paragraph(as_text(callout), styles["Callout"]))

    table = section.get("table")
    if isinstance(table, dict):
        columns = [as_text(col) for col in as_list(table.get("columns"))]
        rows = table.get("rows") if isinstance(table.get("rows"), list) else []
        table_data = []
        if columns:
            table_data.append([paragraph_cell(col, styles["BodyText"]) for col in columns])
        for row in rows:
            cells = row if isinstance(row, list) else [row]
            table_data.append([paragraph_cell(cell, styles["BodyText"]) for cell in cells])
        if table_data:
            # Normalize ragged rows so ReportLab receives a rectangular table
            # and wraps long cell text instead of clipping it.
            col_count = max(len(row) for row in table_data)
            normalized_rows = [row + [""] * (col_count - len(row)) for row in table_data]
            pdf_table = Table(normalized_rows, repeatRows=1 if columns else 0)
            pdf_table.setStyle(
                TableStyle(
                    [
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E2E8F0")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ]
                )
            )
            story.append(pdf_table)
            story.append(Spacer(1, 0.12 * inch))

if not story:
    story.append(Paragraph("Untitled", styles["Title"]))

doc.build(story)
`;

// DOCX creation uses the same structured content shape as simple PDFs. Keeping
// that contract shared lets an agent choose editable Word or final PDF output
// without rewriting the content model.
const PYTHON_DOCX_CREATE_SCRIPT = String.raw`
import json
import sys
from docx import Document

def as_list(value):
    return value if isinstance(value, list) else ([] if value is None else [value])

payload = json.load(sys.stdin)
spec = payload.get("spec") or {}
document = Document()
if spec.get("title"):
    document.add_heading(str(spec["title"]), 0)
if spec.get("subtitle"):
    document.add_paragraph(str(spec["subtitle"]), style="Subtitle")
sections = as_list(spec.get("sections")) or [{"paragraphs": as_list(spec.get("paragraphs")), "bullets": as_list(spec.get("bullets"))}]
for raw_section in sections:
    section = raw_section if isinstance(raw_section, dict) else {"paragraphs": [raw_section]}
    if section.get("heading"):
        document.add_heading(str(section["heading"]), level=1)
    for paragraph in as_list(section.get("paragraphs")):
        document.add_paragraph(str(paragraph))
    for bullet in as_list(section.get("bullets")):
        document.add_paragraph(str(bullet), style="List Bullet")
    table_spec = section.get("table")
    if isinstance(table_spec, dict):
        columns = as_list(table_spec.get("columns"))
        rows = as_list(table_spec.get("rows"))
        width = max([len(columns)] + [len(row) if isinstance(row, list) else 1 for row in rows], default=0)
        if width:
            table = document.add_table(rows=len(rows) + (1 if columns else 0), cols=width)
            table.style = "Table Grid"
            offset = 0
            if columns:
                for index, value in enumerate(columns):
                    table.cell(0, index).text = str(value)
                offset = 1
            for row_index, raw_row in enumerate(rows, start=offset):
                row = raw_row if isinstance(raw_row, list) else [raw_row]
                for column_index, value in enumerate(row):
                    table.cell(row_index, column_index).text = str(value)
document.save(payload["outputPath"])
`;

// XLSX specs preserve values and formulas as typed workbook cells. This is a
// deliberately small authoring surface: sheets, rows, widths, and frozen panes.
const PYTHON_XLSX_CREATE_SCRIPT = String.raw`
import json
import sys
from openpyxl import Workbook

payload = json.load(sys.stdin)
spec = payload.get("spec") or {}
workbook = Workbook()
workbook.remove(workbook.active)
sheets = spec.get("sheets") if isinstance(spec.get("sheets"), list) else []
if not sheets:
    sheets = [{"name": spec.get("title") or "Sheet1", "rows": spec.get("rows") or []}]
for index, sheet_spec in enumerate(sheets):
    sheet = workbook.create_sheet(str(sheet_spec.get("name") or f"Sheet{index + 1}"))
    for row in sheet_spec.get("rows") or []:
        sheet.append(row if isinstance(row, list) else [row])
    if sheet_spec.get("freeze"):
        sheet.freeze_panes = str(sheet_spec["freeze"])
    widths = sheet_spec.get("widths") or {}
    if isinstance(widths, dict):
        for column, width in widths.items():
            sheet.column_dimensions[str(column)].width = float(width)
workbook.save(payload["outputPath"])
`;

// Native deck creation stays in Python because the bundled artifact runtime
// already carries python-pptx. The TypeScript side owns validation, paths, and
// dependency resolution; the Python side owns Office file authoring.
const PYTHON_PPTX_CREATE_SCRIPT = String.raw`
import json
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt


def as_text(value):
    if value is None:
        return ""
    return str(value)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def add_textbox(slide, left, top, width, height, text, font_size=24, bold=False):
    box = slide.shapes.add_textbox(left, top, width, height)
    frame = box.text_frame
    frame.clear()
    paragraph = frame.paragraphs[0]
    paragraph.text = as_text(text)
    run = paragraph.runs[0] if paragraph.runs else paragraph.add_run()
    run.font.size = Pt(font_size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(24, 24, 27)
    return box


def add_bullets(slide, bullets):
    box = slide.shapes.add_textbox(Inches(0.9), Inches(1.55), Inches(11.6), Inches(4.45))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    for index, item in enumerate(bullets):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.text = as_text(item)
        paragraph.level = 0
        # Textboxes do not automatically render bullets; add the OOXML bullet
        # marker directly so LibreOffice and PowerPoint both preserve it.
        ppr = paragraph._p.get_or_add_pPr()
        ppr.set("marL", "457200")
        ppr.set("hanging", "228600")
        bullet = OxmlElement("a:buChar")
        bullet.set("char", chr(8226))
        ppr.insert(0, bullet)
        paragraph.font.size = Pt(24)
        paragraph.font.color.rgb = RGBColor(39, 39, 42)
    return box


def add_table(slide, table):
    columns = [as_text(col) for col in as_list(table.get("columns"))]
    rows = table.get("rows") if isinstance(table.get("rows"), list) else []
    if not columns and not rows:
        return
    row_count = len(rows) + (1 if columns else 0)
    col_count = max([len(columns)] + [len(row) if isinstance(row, list) else 1 for row in rows])
    shape = slide.shapes.add_table(row_count, col_count, Inches(0.8), Inches(1.55), Inches(11.75), Inches(4.7))
    ppt_table = shape.table
    if columns:
        for col_index, col in enumerate(columns):
            ppt_table.cell(0, col_index).text = col
    start_row = 1 if columns else 0
    for row_index, row in enumerate(rows, start=start_row):
        cells = row if isinstance(row, list) else [row]
        for col_index, cell in enumerate(cells):
            ppt_table.cell(row_index, col_index).text = as_text(cell)


payload = json.load(sys.stdin)
spec = payload.get("spec") or {}
output_path = payload["outputPath"]

presentation = Presentation()
presentation.slide_width = Inches(13.333)
presentation.slide_height = Inches(7.5)
blank_layout = presentation.slide_layouts[6]

title = as_text(spec.get("title")).strip()
subtitle = as_text(spec.get("subtitle")).strip()
if title or subtitle:
    slide = presentation.slides.add_slide(blank_layout)
    add_textbox(slide, Inches(0.85), Inches(2.25), Inches(11.65), Inches(0.7), title or "Untitled", 36, True)
    if subtitle:
        subtitle_box = add_textbox(slide, Inches(0.9), Inches(3.1), Inches(11.5), Inches(0.45), subtitle, 20, False)
        subtitle_box.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER

slides = as_list(spec.get("slides"))
if not slides:
    slides = as_list(spec.get("sections"))

for raw_slide in slides:
    slide_spec = raw_slide if isinstance(raw_slide, dict) else {"title": raw_slide}
    slide = presentation.slides.add_slide(blank_layout)
    slide_title = as_text(slide_spec.get("title") or slide_spec.get("heading")).strip() or "Slide"
    add_textbox(slide, Inches(0.65), Inches(0.45), Inches(12.0), Inches(0.55), slide_title, 30, True)

    paragraph = as_text(slide_spec.get("paragraph")).strip()
    if paragraph:
        add_textbox(slide, Inches(0.9), Inches(1.45), Inches(11.5), Inches(1.1), paragraph, 22, False)

    bullets = [as_text(item).strip() for item in as_list(slide_spec.get("bullets")) if as_text(item).strip()]
    if bullets:
        add_bullets(slide, bullets)

    table = slide_spec.get("table")
    if isinstance(table, dict):
        add_table(slide, table)

if len(presentation.slides) == 0:
    slide = presentation.slides.add_slide(blank_layout)
    add_textbox(slide, Inches(0.85), Inches(2.7), Inches(11.65), Inches(0.7), "Untitled", 36, True)

presentation.save(output_path)
`;

function getRuntimeAndRunner(deps?: ArtifactCommandDeps) {
  return {
    runtime: deps?.runtime ?? resolveArtifactRuntime(),
    runner: deps?.runner ?? defaultArtifactCommandRunner,
  };
}

function assertSuccessfulCommand(result: { code: number | null; stdout: string; stderr: string }) {
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(
      [`Artifact command failed with code ${result.code ?? "unknown"}.`, stderr, stdout]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function resolveArtifactOutputPath(input: string, output: string | undefined, ext: string) {
  if (output?.trim()) {
    return path.resolve(output.trim());
  }
  const parsed = path.parse(input);
  return path.resolve(parsed.dir, `${parsed.name}.${ext.replace(/^\./, "")}`);
}

export async function artifactRuntimeStatusCommand(deps?: ArtifactCommandDeps) {
  return getRuntimeAndRunner(deps).runtime;
}

export async function createPdfCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  const { runtime, runner } = getRuntimeAndRunner(deps);
  const python = requireArtifactExecutable(runtime, "python");
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, opts.out, "pdf");

  await fs.access(inputPath);
  const rawSpec = await fs.readFile(inputPath, "utf8");
  let spec: unknown;
  try {
    spec = JSON.parse(rawSpec);
  } catch (err) {
    throw new Error(
      `PDF spec must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  await ensureParentDir(outputPath);
  const result = await runner([python, "-c", REPORTLAB_CREATE_PDF_SCRIPT], {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: JSON.stringify({ spec, outputPath }),
  });
  assertSuccessfulCommand(result);
  await fs.access(outputPath);

  return { ok: true, path: outputPath, details: { source: inputPath, engine: "reportlab" } };
}

async function createStructuredArtifactCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number },
  deps: ArtifactCommandDeps | undefined,
  extension: "docx" | "xlsx",
  script: string,
  engine: string,
): Promise<ArtifactFileResult> {
  const { runtime, runner } = getRuntimeAndRunner(deps);
  const python = requireArtifactExecutable(runtime, "python");
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, opts.out, extension);
  await fs.access(inputPath);
  let spec: unknown;
  try {
    spec = JSON.parse(await fs.readFile(inputPath, "utf8"));
  } catch (err) {
    throw new Error(
      `${extension.toUpperCase()} spec must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  await ensureParentDir(outputPath);
  const result = await runner([python, "-c", script], {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: JSON.stringify({ spec, outputPath }),
  });
  assertSuccessfulCommand(result);
  await fs.access(outputPath);
  return { ok: true, path: outputPath, details: { source: inputPath, engine } };
}

export async function createDocxCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
) {
  return await createStructuredArtifactCommand(
    input,
    opts,
    deps,
    "docx",
    PYTHON_DOCX_CREATE_SCRIPT,
    "python-docx",
  );
}

export async function createXlsxCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
) {
  return await createStructuredArtifactCommand(
    input,
    opts,
    deps,
    "xlsx",
    PYTHON_XLSX_CREATE_SCRIPT,
    "openpyxl",
  );
}

async function officeToPdfCommand(
  input: string,
  opts: { out?: string; outDir?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  const { runtime, runner } = getRuntimeAndRunner(deps);
  const soffice = requireArtifactExecutable(runtime, "soffice");
  const inputPath = path.resolve(input);
  const requestedOutDir = opts.outDir?.trim() ? path.resolve(opts.outDir.trim()) : undefined;
  const outputPath = opts.out?.trim()
    ? path.resolve(opts.out.trim())
    : path.join(requestedOutDir ?? path.dirname(inputPath), `${path.parse(inputPath).name}.pdf`);
  const outDir = path.dirname(outputPath);
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-lo-"));
  // LibreOffice always chooses the input basename. Convert in an isolated
  // directory so an explicit output such as brief-docx.pdf cannot overwrite a
  // pre-existing brief.pdf before we move the generated file into place.
  const conversionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-output-"));

  await fs.access(inputPath);
  await fs.mkdir(outDir, { recursive: true });

  try {
    const result = await runner(
      [
        soffice,
        "--headless",
        `-env:UserInstallation=${pathToLibreOfficeFileUrl(profileDir)}`,
        "--convert-to",
        "pdf",
        "--outdir",
        conversionDir,
        inputPath,
      ],
      { timeoutMs: opts.timeoutMs ?? 120_000 },
    );
    assertSuccessfulCommand(result);

    const generatedPath = path.join(conversionDir, `${path.parse(inputPath).name}.pdf`);
    await ensureParentDir(outputPath);
    await fs.rename(generatedPath, outputPath);
  } finally {
    await Promise.all([
      fs.rm(profileDir, { recursive: true, force: true }),
      fs.rm(conversionDir, { recursive: true, force: true }),
    ]);
  }

  return { ok: true, path: outputPath, details: { outDir, source: inputPath } };
}

export async function createPptxCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  const { runtime, runner } = getRuntimeAndRunner(deps);
  const python = requireArtifactExecutable(runtime, "python");
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, opts.out, "pptx");

  await fs.access(inputPath);
  const rawSpec = await fs.readFile(inputPath, "utf8");
  let spec: unknown;
  try {
    spec = JSON.parse(rawSpec);
  } catch (err) {
    throw new Error(
      `PPTX spec must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  await ensureParentDir(outputPath);
  const result = await runner([python, "-c", PYTHON_PPTX_CREATE_SCRIPT], {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: JSON.stringify({ spec, outputPath }),
  });
  assertSuccessfulCommand(result);
  await fs.access(outputPath);

  return { ok: true, path: outputPath, details: { source: inputPath, engine: "python-pptx" } };
}

export async function docxToPdfCommand(
  input: string,
  opts: { out?: string; outDir?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  return officeToPdfCommand(input, opts, deps);
}

export async function pptxToPdfCommand(
  input: string,
  opts: { out?: string; outDir?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  return officeToPdfCommand(input, opts, deps);
}

function pathToLibreOfficeFileUrl(dir: string) {
  const normalized = path.resolve(dir);
  const withLeadingSlash = normalized.startsWith(path.sep)
    ? normalized
    : `${path.sep}${normalized}`;
  return `file://${withLeadingSlash.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export async function renderPdfCommand(
  input: string,
  opts: { outDir?: string; prefix?: string; timeoutMs?: number } = {},
  deps?: ArtifactCommandDeps,
) {
  const { runtime, runner } = getRuntimeAndRunner(deps);
  const pdftoppm = requireArtifactExecutable(runtime, "pdftoppm");
  const inputPath = path.resolve(input);
  const outDir = path.resolve(
    opts.outDir?.trim() || path.join(path.dirname(inputPath), "rendered"),
  );
  const prefix = opts.prefix?.trim() || path.parse(inputPath).name;
  const outputPrefix = path.join(outDir, prefix);

  await fs.access(inputPath);
  await fs.mkdir(outDir, { recursive: true });

  const before = new Set(await fs.readdir(outDir).catch(() => []));
  const result = await runner([pdftoppm, "-png", inputPath, outputPrefix], {
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  assertSuccessfulCommand(result);

  const after = await fs.readdir(outDir);
  const pages = after
    .filter((name) => !before.has(name) && name.startsWith(`${prefix}-`) && name.endsWith(".png"))
    .toSorted()
    .map((name) => path.join(outDir, name));

  return { ok: true as const, paths: pages, details: { outDir, prefix, source: inputPath } };
}

export async function htmlToPdfCommand(
  input: string,
  opts: {
    out?: string;
    scale?: string | number;
    format?: string;
    preferCssPageSize?: boolean;
    timeoutMs?: number;
  } = {},
  deps?: ArtifactCommandDeps,
): Promise<ArtifactFileResult> {
  const { runtime } = getRuntimeAndRunner(deps);
  const chrome = requireArtifactExecutable(runtime, "chrome");
  const outputPath = resolveArtifactOutputPath(input, opts.out, "pdf");
  const scale = normalizePdfScale(opts.scale);
  const url = resolveHtmlInputUrl(input);
  const { chromium } = await import("playwright-core");

  await ensureParentDir(outputPath);
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-first-run", "--disable-background-networking"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 60_000 });
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: outputPath,
      printBackground: true,
      scale,
      format: opts.format?.trim() || "Letter",
      preferCSSPageSize: Boolean(opts.preferCssPageSize),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    ok: true,
    path: outputPath,
    details: {
      source: url,
      scale,
      format: opts.format?.trim() || "Letter",
      preferCssPageSize: Boolean(opts.preferCssPageSize),
    },
  };
}
