#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

function listJavaScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectRelativeJavaScriptImports(source) {
  const imports = new Set();
  const runtimeSource = stripJavaScriptComments(source);
  const patterns = [
    /(?<!@)\bimport\s*\(\s*["'](\.{1,2}\/[^"']+\.js)["']\s*\)/g,
    /\bfrom\s*["'](\.{1,2}\/[^"']+\.js)["']/g,
    /(?<!@)\bimport\s*["'](\.{1,2}\/[^"']+\.js)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of runtimeSource.matchAll(pattern)) {
      const lineStart = runtimeSource.lastIndexOf("\n", match.index) + 1;
      const linePrefix = runtimeSource.slice(lineStart, match.index);
      if (linePrefix.includes("@import")) {
        continue;
      }
      imports.add(match[1]);
    }
  }

  return [...imports];
}

function stripJavaScriptComments(source) {
  let output = "";
  let index = 0;
  let quote = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      if (end === -1) {
        break;
      }
      output += "\n";
      index = end + 1;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        break;
      }
      output += source.slice(index, end + 2).replace(/[^\n]/g, " ");
      index = end + 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

export function findMissingDistImports(distDir = DEFAULT_DIST_DIR) {
  const resolvedDist = path.resolve(distDir);
  const missing = [];

  for (const filePath of listJavaScriptFiles(resolvedDist)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const specifier of collectRelativeJavaScriptImports(source)) {
      const targetPath = path.resolve(path.dirname(filePath), specifier);
      if (!fs.existsSync(targetPath)) {
        missing.push({
          importer: path.relative(resolvedDist, filePath),
          specifier,
          missing: path.relative(resolvedDist, targetPath),
        });
      }
    }
  }

  return missing.toSorted((a, b) =>
    `${a.importer}\0${a.specifier}`.localeCompare(`${b.importer}\0${b.specifier}`),
  );
}

export function formatMissingDistImports(missing) {
  if (missing.length === 0) {
    return "";
  }

  const lines = [
    `[check-dist-imports] found ${missing.length} missing generated JS import${missing.length === 1 ? "" : "s"}:`,
  ];
  for (const entry of missing) {
    lines.push(`- ${entry.importer} imports ${entry.specifier} (missing ${entry.missing})`);
  }
  return lines.join("\n");
}

function main() {
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIST_DIR;

  if (!fs.existsSync(distDir)) {
    console.error(`[check-dist-imports] missing dist directory: ${distDir}`);
    process.exit(1);
  }

  const missing = findMissingDistImports(distDir);
  if (missing.length > 0) {
    console.error(formatMissingDistImports(missing));
    process.exit(1);
  }

  console.log(`[check-dist-imports] ok: ${distDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
