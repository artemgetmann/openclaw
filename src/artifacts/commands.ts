import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDocx, createPdf, createPptx, createXlsx } from "./create.js";
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
): Promise<ArtifactFileResult> {
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, opts.out, "pdf");
  const spec = await readArtifactSpec(inputPath, "PDF");
  await ensureParentDir(outputPath);
  await createPdf(spec, outputPath);
  return { ok: true, path: outputPath, details: { source: inputPath, engine: "pdf-lib" } };
}

async function readArtifactSpec(inputPath: string, label: string): Promise<unknown> {
  await fs.access(inputPath);
  try {
    return JSON.parse(await fs.readFile(inputPath, "utf8"));
  } catch (err) {
    throw new Error(
      `${label} spec must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

async function createBundledArtifactCommand(
  input: string,
  output: string | undefined,
  extension: "docx" | "xlsx",
  creator: (spec: unknown, outputPath: string) => Promise<void>,
  engine: string,
): Promise<ArtifactFileResult> {
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, output, extension);
  const spec = await readArtifactSpec(inputPath, extension.toUpperCase());
  await ensureParentDir(outputPath);
  await creator(spec, outputPath);
  return { ok: true, path: outputPath, details: { source: inputPath, engine } };
}

export async function createDocxCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
) {
  return await createBundledArtifactCommand(input, opts.out, "docx", createDocx, "docx");
}

export async function createXlsxCommand(
  input: string,
  opts: { out?: string; timeoutMs?: number } = {},
) {
  return await createBundledArtifactCommand(input, opts.out, "xlsx", createXlsx, "exceljs");
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
): Promise<ArtifactFileResult> {
  const inputPath = path.resolve(input);
  const outputPath = resolveArtifactOutputPath(inputPath, opts.out, "pptx");
  const spec = await readArtifactSpec(inputPath, "PPTX");
  await ensureParentDir(outputPath);
  await createPptx(spec, outputPath);
  return { ok: true, path: outputPath, details: { source: inputPath, engine: "pptxgenjs" } };
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
