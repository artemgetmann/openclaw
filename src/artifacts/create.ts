import fs from "node:fs/promises";
import JSZip from "jszip";

type JsonRecord = Record<string, unknown>;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

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
  return sections.length > 0
    ? sections
    : [{ paragraphs: asList(spec.paragraphs), bullets: asList(spec.bullets) }];
}

function tableRows(tableValue: unknown): string[][] {
  const table = asRecord(tableValue);
  const columns = asList(table.columns).map(asText);
  const rows = asList(table.rows).map((row) => asList(row).map(asText));
  const allRows = columns.length > 0 ? [columns, ...rows] : rows;
  const columnCount = Math.max(0, ...allRows.map((row) => row.length));
  // OOXML tables are rectangular. Explicit empty cells preserve borders and
  // column alignment for ragged JSON input.
  return allRows.map((row) =>
    Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? ""),
  );
}

function xmlEscape(value: unknown): string {
  return asText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeZip(zip: JSZip, outputPath: string): Promise<void> {
  // DEFLATE is supported by every Office implementation and keeps the app
  // independent from system zip binaries.
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
  await fs.writeFile(outputPath, archive);
}

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

function wordRun(text: string, options: { bold?: boolean; size?: number } = {}): string {
  const properties =
    options.bold || options.size
      ? `<w:rPr>${options.bold ? "<w:b/>" : ""}${
          options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : ""
        }</w:rPr>`
      : "";
  return `<w:r>${properties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function wordParagraph(
  text: string,
  options: { style?: string; bold?: boolean; size?: number } = {},
): string {
  const paragraphProperties = options.style
    ? `<w:pPr><w:pStyle w:val="${options.style}"/></w:pPr>`
    : "";
  return `<w:p>${paragraphProperties}${wordRun(text, options)}</w:p>`;
}

export async function createDocx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const body: string[] = [];
  const title = asText(spec.title).trim();
  if (title) {
    body.push(wordParagraph(title, { style: "Title" }));
  }
  const subtitle = asText(spec.subtitle).trim();
  if (subtitle) {
    body.push(wordParagraph(subtitle, { style: "Subtitle" }));
  }
  for (const section of sectionsFor(spec)) {
    const heading = asText(section.heading).trim();
    if (heading) {
      body.push(wordParagraph(heading, { style: "Heading1" }));
    }
    for (const paragraph of asList(section.paragraphs)) {
      body.push(wordParagraph(asText(paragraph)));
    }
    for (const bullet of asList(section.bullets)) {
      // A literal bullet keeps the minimal package independent from a Word
      // numbering part while remaining editable in every Office reader.
      body.push(wordParagraph(`• ${asText(bullet)}`));
    }
    const rows = tableRows(section.table);
    if (rows.length > 0) {
      body.push(
        `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows
          .map(
            (row) =>
              `<w:tr>${row
                .map((cell) => `<w:tc><w:tcPr/>${wordParagraph(cell)}</w:tc>`)
                .join("")}</w:tr>`,
          )
          .join("")}</w:tbl>`,
      );
    }
  }
  if (body.length === 0) {
    body.push(wordParagraph("Untitled", { style: "Title" }));
  }

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style></w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  await writeZip(zip, outputPath);
}

function uniqueWorksheetName(requested: string, existingNames: Set<string>): string {
  const sanitized = requested.replace(/[\\/?*:[\]]/g, "_");
  const base = (sanitized.trim() || "Sheet").slice(0, 31);
  let candidate = base;
  let suffix = 1;
  // Excel compares worksheet names case-insensitively and caps them at 31
  // characters. Suffix duplicates without exceeding that limit.
  while (existingNames.has(candidate.toLocaleLowerCase())) {
    const suffixText = String(suffix);
    candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  existingNames.add(candidate.toLocaleLowerCase());
  return candidate;
}

function columnNumber(label: string): number {
  return label
    .toUpperCase()
    .split("")
    .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function columnLabel(index: number): string {
  let value = index;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function xlsxCell(value: unknown, reference: string): string {
  if (typeof value === "string" && value.startsWith("=")) {
    return `<c r="${reference}"><f>${xmlEscape(value.slice(1))}</f></c>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
    asText(value),
  )}</t></is></c>`;
}

export async function createXlsx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const worksheetNames = new Set<string>();
  const requestedSheets = asList(spec.sheets);
  const sheetValues =
    requestedSheets.length > 0
      ? requestedSheets
      : [{ name: spec.title || "Sheet1", rows: spec.rows || [] }];
  const sheets = sheetValues.map((value, index) => {
    const sheetSpec = asRecord(value);
    return {
      spec: sheetSpec,
      name: uniqueWorksheetName(
        asText(sheetSpec.name).trim() || `Sheet${index + 1}`,
        worksheetNames,
      ),
    };
  });

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );

  for (const [sheetIndex, sheet] of sheets.entries()) {
    const rows = asList(sheet.spec.rows);
    const rowXml = rows
      .map((row, rowIndex) => {
        const cells = Array.isArray(row) ? row : [row];
        return `<row r="${rowIndex + 1}">${cells
          .map((cell, columnIndex) =>
            xlsxCell(cell, `${columnLabel(columnIndex + 1)}${rowIndex + 1}`),
          )
          .join("")}</row>`;
      })
      .join("");
    const freeze = asText(sheet.spec.freeze).trim();
    const freezeMatch = /^([A-Z]+)(\d+)$/i.exec(freeze);
    const pane = freezeMatch
      ? (() => {
          const xSplit = columnNumber(freezeMatch[1]) - 1;
          const ySplit = Number(freezeMatch[2]) - 1;
          const activePane =
            xSplit > 0 && ySplit > 0 ? "bottomRight" : xSplit > 0 ? "topRight" : "bottomLeft";
          return `<pane${xSplit > 0 ? ` xSplit="${xSplit}"` : ""}${ySplit > 0 ? ` ySplit="${ySplit}"` : ""} topLeftCell="${freezeMatch[0].toUpperCase()}" activePane="${activePane}" state="frozen"/>`;
        })()
      : "";
    const columns = Object.entries(asRecord(sheet.spec.widths))
      .map(([column, width]) => {
        const parsedWidth = Number(width);
        const parsedColumn = /^\d+$/.test(column) ? Number(column) : columnNumber(column);
        return Number.isFinite(parsedWidth) && parsedWidth > 0 && parsedColumn > 0
          ? `<col min="${parsedColumn}" max="${parsedColumn}" width="${parsedWidth}" customWidth="1"/>`
          : "";
      })
      .filter(Boolean)
      .join("");
    zip.file(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns ? `<cols>${columns}</cols>` : ""}<sheetData>${rowXml}</sheetData></worksheet>`,
    );
  }
  await writeZip(zip, outputPath);
}

function pptxTextShape(
  id: number,
  name: string,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  options: { size: number; bold?: boolean; align?: "ctr" | "l" } = { size: 1800 },
): string {
  const paragraphs = text.split("\n").map((line) => {
    const bullet = line.startsWith("• ");
    const content = bullet ? line.slice(2) : line;
    return `<a:p><a:pPr algn="${options.align ?? "l"}"${bullet ? ' marL="342900" indent="-285750"><a:buChar char="•"/></a:pPr>' : "/>"}<a:r><a:rPr lang="en-US" sz="${options.size}"${options.bold ? ' b="1"' : ""}/><a:t>${xmlEscape(content)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${options.size}"/></a:p>`;
  });
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`;
}

function pptxTable(id: number, rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const width = 10_972_800;
  const columnWidth = Math.floor(width / columnCount);
  const cellXml = (cell: string, header: boolean) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"${header ? ' b="1"' : ""}/><a:t>${xmlEscape(cell)}</a:t></a:r><a:endParaRPr lang="en-US" sz="1400"/></a:p></a:txBody><a:tcPr/></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="571500" y="1397000"/><a:ext cx="${width}" cy="4191000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${Array.from({ length: columnCount }, () => `<a:gridCol w="${columnWidth}"/>`).join("")}</a:tblGrid>${rows.map((row, rowIndex) => `<a:tr h="457200">${row.map((cell) => cellXml(cell, rowIndex === 0)).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function pptxSlideXml(spec: JsonRecord, titleSlide: boolean): string {
  const shapes: string[] = [];
  let nextId = 2;
  const title = asText(spec.title || spec.heading).trim() || (titleSlide ? "Untitled" : "Slide");
  shapes.push(
    pptxTextShape(
      nextId++,
      "Title",
      title,
      titleSlide
        ? { x: 731_520, y: 1_981_200, width: 10_759_440, height: 914_400 }
        : { x: 571_500, y: 274_320, width: 10_972_800, height: 685_800 },
      { size: titleSlide ? 2800 : 2400, bold: true, align: titleSlide ? "ctr" : "l" },
    ),
  );
  const subtitle = titleSlide ? asText(spec.subtitle).trim() : "";
  if (subtitle) {
    shapes.push(
      pptxTextShape(
        nextId++,
        "Subtitle",
        subtitle,
        { x: 914_400, y: 3_048_000, width: 10_363_200, height: 685_800 },
        { size: 1800, align: "ctr" },
      ),
    );
  }
  const paragraph = asText(spec.paragraph).trim();
  const bullets = asList(spec.bullets).map(asText).filter(Boolean);
  const body = [paragraph, ...bullets.map((bullet) => `• ${bullet}`)].filter(Boolean).join("\n");
  if (body) {
    shapes.push(
      pptxTextShape(
        nextId++,
        "Body",
        body,
        { x: 822_960, y: 1_371_600, width: 10_546_080, height: 4_648_200 },
        { size: 1800 },
      ),
    );
  }
  const rows = tableRows(spec.table);
  if (rows.length > 0) {
    shapes.push(pptxTable(nextId++, rows));
  }
  return `${XML_DECLARATION}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const PPTX_GROUP_SHAPE = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

export async function createPptx(specValue: unknown, outputPath: string): Promise<void> {
  const spec = asRecord(specValue);
  const slideSpecs: Array<{ spec: JsonRecord; titleSlide: boolean }> = [];
  const title = asText(spec.title).trim();
  const subtitle = asText(spec.subtitle).trim();
  if (title || subtitle) {
    slideSpecs.push({ spec, titleSlide: true });
  }
  const requestedSlides =
    asList(spec.slides).length > 0 ? asList(spec.slides) : asList(spec.sections);
  for (const value of requestedSlides) {
    slideSpecs.push({
      spec:
        value && typeof value === "object" && !Array.isArray(value)
          ? asRecord(value)
          : { title: value },
      titleSlide: false,
    });
  }
  if (slideSpecs.length === 0) {
    slideSpecs.push({ spec: { title: "Untitled" }, titleSlide: true });
  }

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideSpecs.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title || "Untitled")}</dc:title><dc:creator>Jarvis</dc:creator><cp:lastModifiedBy>Jarvis</cp:lastModifiedBy></cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Jarvis</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideSpecs.length}</Slides></Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `${XML_DECLARATION}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideSpecs.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideSpecs.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `${XML_DECLARATION}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Jarvis"><p:spTree>${PPTX_GROUP_SHAPE}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `${XML_DECLARATION}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${PPTX_GROUP_SHAPE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Jarvis"><a:themeElements><a:clrScheme name="Jarvis"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DB2777"/></a:accent5><a:accent6><a:srgbClr val="475569"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Jarvis"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Jarvis"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:noFill/></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  for (const [index, slide] of slideSpecs.entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, pptxSlideXml(slide.spec, slide.titleSlide));
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    );
  }
  await writeZip(zip, outputPath);
}
