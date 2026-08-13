import {
  artifactRuntimeStatusCommand,
  createDocxCommand,
  createPdfCommand,
  createPptxCommand,
  createXlsxCommand,
  docxToPdfCommand,
  htmlToPdfCommand,
  pptxToPdfCommand,
  renderPdfCommand,
} from "../artifacts/commands.js";
import type { RuntimeEnv } from "../runtime.js";

function writeJson(runtime: RuntimeEnv, value: unknown) {
  runtime.log(JSON.stringify(value, null, 2));
}

export async function artifactsStatusCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const status = await artifactRuntimeStatusCommand();
  if (opts.json) {
    writeJson(runtime, status);
    return;
  }
  runtime.log("Artifact runtime:");
  for (const [name, resolved] of Object.entries(status.executables)) {
    runtime.log(`  ${name}: ${resolved.path ?? "missing"} (${resolved.source})`);
  }
}

export async function artifactsCreatePdfCommand(
  input: string,
  opts: { out?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await createPdfCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`PDF: ${result.path}`);
}

export async function artifactsCreateDocxCommand(
  input: string,
  opts: { out?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await createDocxCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`DOCX: ${result.path}`);
}

export async function artifactsCreateXlsxCommand(
  input: string,
  opts: { out?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await createXlsxCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`XLSX: ${result.path}`);
}

export async function artifactsDocxToPdfCommand(
  input: string,
  opts: { out?: string; outDir?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await docxToPdfCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`PDF: ${result.path}`);
}

export async function artifactsCreatePptxCommand(
  input: string,
  opts: { out?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await createPptxCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`PPTX: ${result.path}`);
}

export async function artifactsPptxToPdfCommand(
  input: string,
  opts: { out?: string; outDir?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await pptxToPdfCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`PDF: ${result.path}`);
}

export async function artifactsRenderPdfCommand(
  input: string,
  opts: { outDir?: string; prefix?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const result = await renderPdfCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  for (const page of result.paths) {
    runtime.log(`PNG: ${page}`);
  }
}

export async function artifactsHtmlToPdfCommand(
  input: string,
  opts: {
    out?: string;
    scale?: string;
    format?: string;
    preferCssPageSize?: boolean;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const result = await htmlToPdfCommand(input, opts);
  if (opts.json) {
    writeJson(runtime, result);
    return;
  }
  runtime.log(`PDF: ${result.path}`);
}
