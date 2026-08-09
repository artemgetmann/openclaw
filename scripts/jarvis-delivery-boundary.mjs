#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import {
  exampleJarvisDeliveryReceipt,
  validateJarvisDeliveryReceipt,
  validateJarvisPullRequest,
} from "./lib/jarvis-delivery-boundary.mjs";

function fail(message, exitCode = 2) {
  process.stderr.write(`[jarvis-delivery-boundary] ${message}\n`);
  process.exit(exitCode);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      fail(`unexpected argument: ${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${key}`);
    }
    options[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function printResult(result) {
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`[jarvis-delivery-boundary] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);

if (command === "example") {
  const receipt = exampleJarvisDeliveryReceipt({
    workScope: options.workScope,
    deliveryTarget: options.deliveryTarget,
  });
  process.stdout.write(
    `<!-- jarvis-delivery-boundary:start -->\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n<!-- jarvis-delivery-boundary:end -->\n`,
  );
} else if (command === "validate-receipt") {
  if (!options.receipt) {
    fail("validate-receipt requires --receipt <path>");
  }
  printResult(validateJarvisDeliveryReceipt(readJson(options.receipt, "receipt"), options));
} else if (command === "validate-pr") {
  if (!options.changedPaths) {
    fail("validate-pr requires --changed-paths <path>");
  }

  let title = options.title ?? "";
  let body = options.bodyFile ? fs.readFileSync(options.bodyFile, "utf8") : "";
  if (options.event) {
    const event = readJson(options.event, "GitHub event");
    title = event.pull_request?.title ?? title;
    body = event.pull_request?.body ?? body;
  }
  printResult(
    validateJarvisPullRequest(
      { title, body, changedPaths: readLines(options.changedPaths) },
      { stage: options.stage },
    ),
  );
} else {
  fail(
    "usage: example [--work-scope ... --delivery-target ...] | validate-receipt --receipt <path> --stage <classification|handoff|closeout> | validate-pr --changed-paths <path> [--event <path>|--title <text> --body-file <path>] --stage <...>",
  );
}
