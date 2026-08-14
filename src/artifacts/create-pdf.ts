import fs from "node:fs/promises";
import {
  asList,
  asRecord,
  asText,
  sectionsFor,
  tableRows,
  type JsonRecord,
} from "./create-common.js";

const WIN_ANSI_SPECIALS = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

function winAnsiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const byte =
      codePoint >= 0x20 && codePoint <= 0x7e
        ? codePoint
        : codePoint >= 0xa0 && codePoint <= 0xff
          ? codePoint
          : WIN_ANSI_SPECIALS.get(codePoint);
    if (byte == null) {
      // Standard PDF fonts cannot represent arbitrary Unicode. Failing is
      // safer than emitting a valid-looking file with silently corrupted text.
      throw new Error(
        `PDF text contains unsupported character ${JSON.stringify(character)}; use DOCX for Unicode text`,
      );
    }
    bytes.push(byte);
  }
  return bytes;
}

function pdfLiteral(text: string): string {
  return winAnsiBytes(text)
    .map((byte) => {
      if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
        return `\\${String.fromCharCode(byte)}`;
      }
      return byte < 0x20 || byte > 0x7e
        ? `\\${byte.toString(8).padStart(3, "0")}`
        : String.fromCharCode(byte);
    })
    .join("");
}

function pdfTextWidth(text: string, size: number, bold: boolean): number {
  // These conservative Helvetica metrics are sufficient for deterministic
  // wrapping without bundling a font parser. Wide glyphs deliberately consume
  // more room than narrow glyphs.
  let units = 0;
  for (const character of text) {
    units += /[MW@%]/.test(character)
      ? 1
      : /[ilI.,' ]/.test(character)
        ? 0.28
        : /[A-Z0-9]/.test(character)
          ? 0.63
          : 0.52;
  }
  return units * size * (bold ? 1.04 : 1);
}

function wrapText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const rawWord of words) {
    // Split unbroken tokens before line wrapping so a single long URL cannot
    // escape the page or stall pagination.
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
    if (chunk) {
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

function buildPdf(pageStreams: string[]): Buffer {
  // Object numbers are fixed so page generation can remain a small, pure
  // function: catalog=1, pages=2, fonts=3/4, then page/content pairs.
  const objects: string[] = [];
  const pageObjectIds = pageStreams.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pageStreams.length} /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  for (const [index, stream] of pageStreams.entries()) {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  }

  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = chunks.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, "latin1"));
  }
  const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const xref = [
    `xref\n0 ${objects.length}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

export async function createPdf(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const pageSize = { width: 612, height: 792 };
  const margin = 50;
  const pages: string[][] = [[]];
  let y = pageSize.height - margin;

  const currentPage = () => pages[pages.length - 1];
  const addPage = () => {
    pages.push([]);
    y = pageSize.height - margin;
  };
  const drawText = (text: string, x: number, baseline: number, size: number, bold: boolean) => {
    currentPage().push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf 0.1 0.1 0.12 rg 1 0 0 1 ${x.toFixed(
        2,
      )} ${baseline.toFixed(2)} Tm (${pdfLiteral(text)}) Tj ET`,
    );
  };
  const writeLines = (text: string, size = 11, bold = false, indent = 0) => {
    const printableText = text.replace(/[\t\n\v\f\r]+/g, " ");
    // Validate before pagination so unsupported text never leaves a partial
    // output file behind.
    winAnsiBytes(printableText);
    const maxWidth = pageSize.width - margin * 2 - indent;
    for (const line of wrapText(printableText, maxWidth, (value) =>
      pdfTextWidth(value, size, bold),
    )) {
      if (y < margin + size) {
        addPage();
      }
      drawText(line, margin + indent, y, size, bold);
      y -= size * 1.35;
    }
  };

  const writeTable = (rows: string[][], repeatHeader: boolean) => {
    if (rows.length === 0) {
      return;
    }
    const columnCount = Math.max(...rows.map((row) => row.length), 1);
    const tableWidth = pageSize.width - margin * 2;
    const columnWidth = tableWidth / columnCount;
    const fontSize = 9;
    const lineHeight = fontSize * 1.3;
    const cellPadding = 4;

    const writeRow = (row: string[], rowIndex: number, repeatOnNewPage: boolean) => {
      const bold = rowIndex === 0;
      const wrappedCells = Array.from({ length: columnCount }, (_, columnIndex) => {
        const text = (row[columnIndex] ?? "").replace(/[\t\n\v\f\r]+/g, " ");
        winAnsiBytes(text);
        return wrapText(text, columnWidth - cellPadding * 2, (value) =>
          pdfTextWidth(value, fontSize, bold),
        );
      });
      let lineOffset = 0;
      const totalLines = Math.max(...wrappedCells.map((lines) => lines.length));
      while (lineOffset < totalLines) {
        let availableLines = Math.floor((y - margin - 8) / lineHeight);
        if (availableLines < 1) {
          addPage();
          if (repeatOnNewPage && repeatHeader && rows[0]) {
            writeRow(rows[0], 0, false);
          }
          availableLines = Math.floor((y - margin - 8) / lineHeight);
          if (availableLines < 1) {
            // A pathological repeated header can fill a page by itself. Skip
            // repetition once so the data row still makes progress.
            addPage();
            availableLines = Math.floor((y - margin - 8) / lineHeight);
          }
        }
        const segmentLines = Math.min(totalLines - lineOffset, availableLines);
        const segmentHeight = segmentLines * lineHeight + 8;
        const rowTop = y;
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const x = margin + columnIndex * columnWidth;
          const fill = rowIndex === 0 ? "0.92 0.93 0.95 rg " : "";
          currentPage().push(
            `q ${fill}0.55 0.57 0.6 RG 0.75 w ${x.toFixed(2)} ${(rowTop - segmentHeight).toFixed(
              2,
            )} ${columnWidth.toFixed(2)} ${segmentHeight.toFixed(2)} re ${fill ? "B" : "S"} Q`,
          );
          const lines = wrappedCells[columnIndex].slice(lineOffset, lineOffset + segmentLines);
          for (const [lineIndex, line] of lines.entries()) {
            drawText(
              line,
              x + cellPadding,
              rowTop - cellPadding - fontSize - lineIndex * lineHeight,
              fontSize,
              bold,
            );
          }
        }
        y -= segmentHeight;
        lineOffset += segmentLines;
      }
    };

    for (const [rowIndex, row] of rows.entries()) {
      writeRow(row, rowIndex, rowIndex > 0);
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
  const sections = sectionsFor(spec);
  const sectionHasContent = (section: JsonRecord) => {
    const hasText = [section.heading, section.paragraphs, section.bullets, section.callout].some(
      (value) => asList(value).some((item) => asText(item).trim()),
    );
    return hasText || tableRows(section.table).length > 0;
  };
  for (const section of sections) {
    if (!sectionHasContent(section)) {
      continue;
    }
    const heading = asText(section.heading).trim();
    if (heading) {
      y -= 4;
      writeLines(heading, 15, true);
    }
    for (const paragraph of asList(section.paragraphs)) {
      const text = asText(paragraph).trim();
      if (text) {
        writeLines(text);
        y -= 5;
      }
    }
    for (const bullet of asList(section.bullets)) {
      const text = asText(bullet).trim();
      if (text) {
        writeLines(`• ${text}`, 11, false, 12);
      }
    }
    const callout = asText(section.callout).trim();
    if (callout) {
      y -= 4;
      writeLines(callout, 11, true, 10);
      y -= 4;
    }
    const table = asRecord(section.table);
    writeTable(tableRows(table), asList(table.columns).length > 0);
    y -= 8;
  }
  if (!title && !subtitle && !sections.some(sectionHasContent)) {
    writeLines("Untitled", 22, true);
  }

  await fs.writeFile(outputPath, buildPdf(pages.map((commands) => commands.join("\n"))));
}
