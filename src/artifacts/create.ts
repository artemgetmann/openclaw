import fs from "node:fs/promises";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type JsonRecord = Record<string, unknown>;

type PptxSlide = {
  addText: (text: unknown, options: JsonRecord) => void;
  addTable: (rows: string[][], options: JsonRecord) => void;
};

type PptxPresentation = {
  layout: string;
  author: string;
  subject: string;
  title: string;
  addSlide: () => PptxSlide;
  writeFile: (options: { fileName: string }) => Promise<string>;
};

type PptxConstructor = new () => PptxPresentation;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function asText(value: unknown): string {
  if (value == null) {
    return "";
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function sectionsFor(spec: JsonRecord): JsonRecord[] {
  const sections = asList(spec.sections).map((section) =>
    section && typeof section === "object" && !Array.isArray(section)
      ? asRecord(section)
      : { paragraphs: [section] },
  );
  if (sections.length > 0) {
    return sections;
  }
  return [{ paragraphs: asList(spec.paragraphs), bullets: asList(spec.bullets) }];
}

function tableRows(tableValue: unknown): string[][] {
  const table = asRecord(tableValue);
  const columns = asList(table.columns).map(asText);
  const rows = asList(table.rows).map((row) => asList(row).map(asText));
  return columns.length > 0 ? [columns, ...rows] : rows;
}

function wrapText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const rawWord of words) {
    // Split unbroken tokens by measured glyph width. Character counts clip
    // wide glyphs such as W and waste space on narrow glyphs such as i.
    const chunks: string[] = [];
    let chunk = "";
    for (const character of rawWord) {
      if (chunk && measure(`${chunk}${character}`) > maxWidth) {
        chunks.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    if (chunk || rawWord.length === 0) {
      chunks.push(chunk);
    }
    for (const word of chunks) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
  }
  if (line || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

export async function createPdf(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [612, 792];
  const margin = 50;
  let page = pdf.addPage(pageSize);
  let y = page.getHeight() - margin;

  // Keep pagination deterministic and local. The creator supports the same
  // small structured contract as the other formats; rich layout stays out of
  // this product feature until it has a separate user need and proof boundary.
  const writeLines = (text: string, size = 11, isBold = false, indent = 0) => {
    const font = isBold ? bold : regular;
    const supportedCharacters = new Set(font.getCharacterSet());
    // Structured input may contain line breaks and tabs. They are layout
    // whitespace, not printable font glyphs, so normalize them before both
    // validation and measured wrapping.
    const printableText = text.replace(/[\t\n\v\f\r]+/g, " ");
    // Standard PDF fonts are deliberately small, but silently replacing user
    // text would create a valid-looking corrupt document. Fail with an exact
    // explanation until a separately reviewed Unicode font is bundled.
    const unsupported = Array.from(printableText).find(
      (character) => !supportedCharacters.has(character.codePointAt(0) ?? 0),
    );
    if (unsupported) {
      throw new Error(
        `PDF text contains unsupported character ${JSON.stringify(unsupported)}; use DOCX for Unicode text`,
      );
    }
    const maxWidth = page.getWidth() - margin * 2 - indent;
    for (const line of wrapText(printableText, maxWidth, (value) =>
      font.widthOfTextAtSize(value, size),
    )) {
      if (y < margin + size) {
        page = pdf.addPage(pageSize);
        y = page.getHeight() - margin;
      }
      page.drawText(line, {
        x: margin + indent,
        y,
        size,
        font,
        color: rgb(0.1, 0.1, 0.12),
      });
      y -= size * 1.35;
    }
  };

  const writeTable = (rows: string[][]) => {
    if (rows.length === 0) {
      return;
    }
    const columnCount = Math.max(...rows.map((row) => row.length), 1);
    const tableWidth = page.getWidth() - margin * 2;
    const columnWidth = tableWidth / columnCount;
    const fontSize = 9;
    const lineHeight = fontSize * 1.3;
    const cellPadding = 4;

    for (const [rowIndex, row] of rows.entries()) {
      // Measure every cell first so the row remains a single aligned unit when
      // it wraps or moves to the next page.
      const rowFont = rowIndex === 0 ? bold : regular;
      const wrappedCells = Array.from({ length: columnCount }, (_, columnIndex) =>
        wrapText(row[columnIndex] ?? "", columnWidth - 8, (value) =>
          rowFont.widthOfTextAtSize(value, fontSize),
        ),
      );
      let lineOffset = 0;
      const totalLines = Math.max(...wrappedCells.map((lines) => lines.length));
      while (lineOffset < totalLines) {
        let availableLines = Math.floor((y - margin - 8) / lineHeight);
        if (availableLines < 1) {
          page = pdf.addPage(pageSize);
          y = page.getHeight() - margin;
          availableLines = Math.floor((y - margin - 8) / lineHeight);
        }
        // A logical row may exceed a whole page. Continue its bordered cells
        // on subsequent pages instead of drawing below the page and clipping.
        const segmentLines = Math.min(totalLines - lineOffset, availableLines);
        const segmentHeight = segmentLines * lineHeight + 8;
        const rowTop = y;
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const x = margin + columnIndex * columnWidth;
          page.drawRectangle({
            x,
            y: rowTop - segmentHeight,
            width: columnWidth,
            height: segmentHeight,
            borderWidth: 0.75,
            borderColor: rgb(0.55, 0.57, 0.6),
            color: rowIndex === 0 ? rgb(0.92, 0.93, 0.95) : undefined,
          });
          const lines = wrappedCells[columnIndex].slice(lineOffset, lineOffset + segmentLines);
          for (const [lineIndex, line] of lines.entries()) {
            page.drawText(line, {
              x: x + cellPadding,
              y: rowTop - cellPadding - fontSize - lineIndex * lineHeight,
              size: fontSize,
              font: rowIndex === 0 ? bold : regular,
              color: rgb(0.1, 0.1, 0.12),
            });
          }
        }
        y -= segmentHeight;
        lineOffset += segmentLines;
      }
    }
  };

  const title = asText(spec.title).trim();
  if (title) {
    writeLines(title, 22, true);
    y -= 8;
  }
  const subtitle = asText(spec.subtitle).trim();
  if (subtitle) {
    writeLines(subtitle, 12);
    y -= 8;
  }
  for (const section of sectionsFor(spec)) {
    const heading = asText(section.heading).trim();
    if (heading) {
      y -= 4;
      writeLines(heading, 15, true);
    }
    for (const paragraph of asList(section.paragraphs)) {
      const text = asText(paragraph).trim();
      if (!text) {
        continue;
      }
      writeLines(text, 11);
      y -= 5;
    }
    for (const bullet of asList(section.bullets)) {
      writeLines(`• ${asText(bullet)}`, 11, false, 12);
    }
    const callout = asText(section.callout).trim();
    if (callout) {
      y -= 4;
      writeLines(callout, 11, true, 10);
      y -= 4;
    }
    writeTable(tableRows(section.table));
    y -= 8;
  }
  const hasSectionContent = sectionsFor(spec).some((section) => {
    // A table object is only visible content when it yields at least one row.
    // Checking the object itself would suppress the fallback for `{ table: {} }`
    // even though the renderer has nothing to draw.
    const hasText = [section.heading, section.paragraphs, section.bullets, section.callout].some(
      (value) => asList(value).some((item) => asText(item).trim()),
    );
    return hasText || tableRows(section.table).length > 0;
  });
  if (!title && !subtitle && !hasSectionContent) {
    writeLines("Untitled", 22, true);
  }

  await fs.writeFile(outputPath, await pdf.save());
}

export async function createDocx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const children: Array<Paragraph | Table> = [];
  const title = asText(spec.title).trim();
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }
  const subtitle = asText(spec.subtitle).trim();
  if (subtitle) {
    children.push(new Paragraph({ text: subtitle, style: "Subtitle" }));
  }
  for (const section of sectionsFor(spec)) {
    const heading = asText(section.heading).trim();
    if (heading) {
      children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const paragraph of asList(section.paragraphs)) {
      children.push(new Paragraph(asText(paragraph)));
    }
    for (const bullet of asList(section.bullets)) {
      children.push(new Paragraph({ text: asText(bullet), bullet: { level: 0 } }));
    }
    const rows = tableRows(section.table);
    if (rows.length > 0) {
      children.push(
        new Table({
          rows: rows.map(
            (row) =>
              new TableRow({
                children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
              }),
          ),
        }),
      );
    }
  }
  if (children.length === 0) {
    children.push(new Paragraph({ text: "Untitled", heading: HeadingLevel.TITLE }));
  }
  const document = new Document({ sections: [{ children }] });
  await fs.writeFile(outputPath, await Packer.toBuffer(document));
}

export async function createXlsx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const workbook = new ExcelJS.Workbook();
  const sheets = asList(spec.sheets);
  const sheetSpecs =
    sheets.length > 0 ? sheets : [{ name: spec.title || "Sheet1", rows: spec.rows || [] }];
  for (const [index, value] of sheetSpecs.entries()) {
    const sheetSpec = asRecord(value);
    const worksheet = workbook.addWorksheet(asText(sheetSpec.name).trim() || `Sheet${index + 1}`);
    for (const row of asList(sheetSpec.rows)) {
      const cells = (Array.isArray(row) ? row : [row]).map((cell) => {
        // Keep the established JSON contract: a leading '=' denotes a real
        // spreadsheet formula, not display text.
        return typeof cell === "string" && cell.startsWith("=") ? { formula: cell.slice(1) } : cell;
      });
      worksheet.addRow(cells);
    }
    const freeze = asText(sheetSpec.freeze).trim();
    if (freeze) {
      const match = /^([A-Z]+)(\d+)$/i.exec(freeze);
      if (match) {
        worksheet.views = [
          { state: "frozen", xSplit: columnNumber(match[1]) - 1, ySplit: Number(match[2]) - 1 },
        ];
      }
    }
    for (const [column, width] of Object.entries(asRecord(sheetSpec.widths))) {
      const parsedWidth = Number(width);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        worksheet.getColumn(column).width = parsedWidth;
      }
    }
  }
  await workbook.xlsx.writeFile(outputPath);
}

function columnNumber(label: string): number {
  return label
    .toUpperCase()
    .split("")
    .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

export async function createPptx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  // PptxGenJS's NodeNext declaration exposes its default class as a namespace
  // even though the ESM runtime exports the constructor. Confine that package
  // interop mismatch to this typed boundary.
  const PptxGenJS = (await import("pptxgenjs")).default as unknown as PptxConstructor;
  const presentation = new PptxGenJS();
  let slideCount = 0;
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "Jarvis";
  presentation.subject = asText(spec.title);
  presentation.title = asText(spec.title) || "Untitled";

  const title = asText(spec.title).trim();
  const subtitle = asText(spec.subtitle).trim();
  if (title || subtitle) {
    const slide = presentation.addSlide();
    slideCount += 1;
    slide.addText(title || "Untitled", {
      x: 0.8,
      y: 2.2,
      w: 11.7,
      h: 0.7,
      fontSize: 28,
      bold: true,
      align: "center",
    });
    if (subtitle) {
      slide.addText(subtitle, { x: 0.9, y: 3.1, w: 11.5, h: 0.45, fontSize: 18, align: "center" });
    }
  }

  const slides = asList(spec.slides).length > 0 ? asList(spec.slides) : asList(spec.sections);
  for (const value of slides) {
    const slideSpec =
      value && typeof value === "object" && !Array.isArray(value)
        ? asRecord(value)
        : { title: value };
    const slide = presentation.addSlide();
    slideCount += 1;
    slide.addText(asText(slideSpec.title || slideSpec.heading).trim() || "Slide", {
      x: 0.65,
      y: 0.4,
      w: 12,
      h: 0.55,
      fontSize: 24,
      bold: true,
    });
    const paragraph = asText(slideSpec.paragraph).trim();
    if (paragraph) {
      slide.addText(paragraph, { x: 0.9, y: 1.4, w: 11.5, h: 1.1, fontSize: 18, breakLine: false });
    }
    const bullets = asList(slideSpec.bullets).map(asText).filter(Boolean);
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((text) => ({ text, options: { bullet: { indent: 18 } } })),
        { x: 0.9, y: 1.55, w: 11.6, h: 4.45, fontSize: 20, breakLine: true },
      );
    }
    const rows = tableRows(slideSpec.table);
    if (rows.length > 0) {
      slide.addTable(rows, {
        x: 0.8,
        y: 1.55,
        w: 11.75,
        h: 4.7,
        fontSize: 14,
        border: { color: "CBD5E1", pt: 1 },
      });
    }
  }
  if (slideCount === 0) {
    const slide = presentation.addSlide();
    slide.addText("Untitled", {
      x: 0.8,
      y: 2.7,
      w: 11.7,
      h: 0.7,
      fontSize: 28,
      bold: true,
      align: "center",
    });
  }
  await presentation.writeFile({ fileName: outputPath });
}
