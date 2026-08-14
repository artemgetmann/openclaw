import JSZip from "jszip";
import {
  XML_DECLARATION,
  asList,
  asRecord,
  asText,
  sectionsFor,
  tableRows,
  writeZip,
  xmlEscape,
} from "./create-common.js";

function wordRun(text: string, options: { bold?: boolean; size?: number } = {}): string {
  const properties =
    options.bold || options.size
      ? `<w:rPr>${options.bold ? "<w:b/>" : ""}${
          options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : ""
        }</w:rPr>`
      : "";
  const content = text
    .split(/\r\n|\r|\n/u)
    .map(
      (line, index) =>
        `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`,
    )
    .join("");
  return `<w:r>${properties}${content}</w:r>`;
}

function wordParagraph(
  text: string,
  options: { style?: string; bold?: boolean; size?: number; bullet?: boolean } = {},
): string {
  const properties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "",
  ].join("");
  const paragraphProperties = properties ? `<w:pPr>${properties}</w:pPr>` : "";
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
      body.push(wordParagraph(asText(bullet), { bullet: true }));
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
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style></w:styles>`,
  );
  zip.file(
    "word/numbering.xml",
    `${XML_DECLARATION}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
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
