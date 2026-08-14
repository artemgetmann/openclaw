import fs from "node:fs/promises";
import JSZip from "jszip";

export type JsonRecord = Record<string, unknown>;

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function asText(value: unknown): string {
  if (value == null) {
    return "";
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

export function sectionsFor(spec: JsonRecord): JsonRecord[] {
  const sections = asList(spec.sections).map((section) =>
    section && typeof section === "object" && !Array.isArray(section)
      ? asRecord(section)
      : { paragraphs: [section] },
  );
  return sections.length > 0
    ? sections
    : [{ paragraphs: asList(spec.paragraphs), bullets: asList(spec.bullets) }];
}

export function tableRows(tableValue: unknown): string[][] {
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

export function xmlEscape(value: unknown): string {
  const text = asText(value);
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const valid =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) {
      throw new Error(
        `OOXML text contains XML 1.0-invalid character ${JSON.stringify(character)} (U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
      );
    }
  }
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function writeZip(zip: JSZip, outputPath: string): Promise<void> {
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
