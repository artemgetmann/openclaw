#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(skillRoot, "../..");
const directScript = path.join(__dirname, "generate_image.py");

function usage() {
  console.error(`Usage:
  generate-image.mjs --prompt <text> --filename <path> [--resolution 1K|2K|4K] [--aspect-ratio <ratio>]
  generate-image.mjs --prompt <text> --filename <path> -i <image> [...]

Notes:
  - Jarvis managed mode handles text-to-image without a local Gemini key.
  - Input-image editing/composition and explicit --api-key use the existing direct BYOK path.`);
}

function readRequiredValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {
    prompt: undefined,
    filename: undefined,
    resolution: undefined,
    aspectRatio: undefined,
    inputImages: [],
    explicitApiKey: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--prompt":
      case "-p":
        parsed.prompt = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--filename":
      case "-f":
        parsed.filename = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--resolution":
      case "-r":
        parsed.resolution = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--aspect-ratio":
      case "-a":
        parsed.aspectRatio = readRequiredValue(argv, index, arg);
        index += 1;
        break;
      case "--input-image":
      case "-i":
        parsed.inputImages.push(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--api-key":
      case "-k":
        parsed.explicitApiKey = true;
        index += 1;
        break;
      default:
        break;
    }
  }

  return parsed;
}

async function importOpenClawRuntime() {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  const sourceEntry = path.join(repoRoot, "src", "index.ts");
  const entry = fs.existsSync(distEntry) ? distEntry : sourceEntry;
  if (entry === sourceEntry) {
    const { register } = await import("node:module");
    register("tsx/esm", pathToFileURL(`${repoRoot}/`));
  }
  return await import(pathToFileURL(entry).href);
}

async function runDirectPython(argv) {
  await new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", directScript, ...argv], {
      cwd: skillRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`direct Gemini image generation exited with code ${String(code)}`));
    });
  });
}

function writeManagedImage(params) {
  const outputPath = path.resolve(params.filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(params.image.data, "base64"));
  if (params.text) {
    console.log(`Model response: ${params.text}`);
  }
  console.log(`\nImage saved: ${outputPath}`);
  console.log(`MEDIA:${outputPath}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (flags.help) {
    usage();
    return;
  }
  if (!flags.prompt || !flags.filename) {
    usage();
    throw new Error("--prompt and --filename are required");
  }

  // Editing/composition still uses the direct Python script because the managed
  // backend endpoint intentionally avoids upload/storage policy in this slice.
  if (flags.explicitApiKey || flags.inputImages.length > 0) {
    if (flags.inputImages.length > 0) {
      console.error(
        "Jarvis managed Gemini image generation does not support input images yet; using direct BYOK path.",
      );
    }
    await runDirectPython(argv);
    return;
  }

  const openclaw = await importOpenClawRuntime();
  const cfg = openclaw.loadConfig();
  if (!openclaw.isJarvisManagedGeminiImageGenerationConfigured(cfg)) {
    await runDirectPython(argv);
    return;
  }

  try {
    const result = await openclaw.runGeminiImageGeneration({
      cfg,
      prompt: flags.prompt,
      resolution: flags.resolution,
      aspectRatio: flags.aspectRatio,
    });
    writeManagedImage({
      filename: flags.filename,
      image: result.images[0],
      text: result.text,
    });
  } catch (error) {
    // A developer with a local key can still get work done when the managed
    // backend is unhealthy; consumers without BYOK should see the backend error.
    if (process.env.GEMINI_API_KEY) {
      console.error(
        `Jarvis managed Gemini image generation failed; using direct BYOK path. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await runDirectPython(argv);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
