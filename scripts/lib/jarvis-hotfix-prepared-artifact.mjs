#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`jarvis-hotfix-prepared-artifact: ${message}\n`);
  process.exit(1);
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function treeDigest(root, requireReadonly = false) {
  const absoluteRoot = path.resolve(root);
  const records = [];
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("prepared artifact root must be a real directory");
  }

  function visit(current) {
    const stat = fs.lstatSync(current);
    const relative = path.relative(absoluteRoot, current) || ".";
    const mode = stat.mode & 0o7777;
    if (requireReadonly && (mode & 0o222) !== 0) {
      fail(`prepared artifact remains writable: ${relative}`);
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(current);
      const resolvedTarget = path.resolve(path.dirname(current), target);
      if (
        resolvedTarget !== absoluteRoot &&
        !resolvedTarget.startsWith(`${absoluteRoot}${path.sep}`)
      ) {
        fail(`prepared artifact symlink escapes its immutable root: ${relative}`);
      }
      records.push([relative, "symlink", mode, target]);
      return;
    }
    if (stat.isDirectory()) {
      records.push([relative, "directory", mode]);
      for (const name of fs.readdirSync(current).toSorted()) {
        visit(path.join(current, name));
      }
      return;
    }
    if (stat.isFile()) {
      records.push([relative, "file", mode, stat.size, sha256(fs.readFileSync(current))]);
      return;
    }
    fail(`unsupported artifact entry type: ${relative}`);
  }

  visit(absoluteRoot);
  return sha256(`${canonical(records)}\n`);
}

function receiptDigest(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receiptDigest;
  return sha256(`${canonical(unsigned)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`);
  }
}

if (command === "hash-tree") {
  if (args.length !== 1) {
    fail("usage: hash-tree <directory>");
  }
  process.stdout.write(`${treeDigest(args[0])}\n`);
} else if (command === "create") {
  if (args.length !== 3) {
    fail("usage: create <app> <metadata.json> <receipt.json>");
  }
  const [app, metadataFile, receiptFile] = args;
  const metadata = readJson(metadataFile);
  const requiredMetadata = [
    "authority",
    "source",
    "inputs",
    "toolchain",
    "app",
    "signing",
    "locks",
    "metrics",
    "createdAt",
    "expiresAt",
  ];
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length !== requiredMetadata.length ||
    requiredMetadata.some((key) => !(key in metadata))
  ) {
    fail("metadata schema or fields are invalid");
  }
  const receipt = {
    schema: 1,
    ...metadata,
    artifact: {
      relativePath: "artifact/Jarvis.app",
      treeSha256: treeDigest(app),
    },
  };
  receipt.receiptDigest = receiptDigest(receipt);
  const temporary = `${receiptFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, receiptFile);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} else if (command === "verify") {
  if (args.length !== 2) {
    fail("usage: verify <app> <receipt.json>");
  }
  const [app, receiptFile] = args;
  const receipt = readJson(receiptFile);
  const allowed = new Set([
    "schema",
    "authority",
    "source",
    "inputs",
    "toolchain",
    "app",
    "signing",
    "locks",
    "metrics",
    "createdAt",
    "expiresAt",
    "artifact",
    "receiptDigest",
  ]);
  if (Object.keys(receipt).some((key) => !allowed.has(key)) || receipt.schema !== 1) {
    fail("receipt schema or fields are invalid");
  }
  if (receipt.receiptDigest !== receiptDigest(receipt)) {
    fail("receipt digest mismatch");
  }
  if (receipt.artifact?.relativePath !== "artifact/Jarvis.app") {
    fail("receipt artifact path is invalid");
  }
  const createdAt = Date.parse(receipt.createdAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const now = Number(process.env.JARVIS_HOTFIX_NOW_MS ?? Date.now());
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    fail("receipt creation or expiry time is invalid");
  }
  if (createdAt > now + 60_000) {
    fail("receipt creation time is in the future");
  }
  if (expiresAt <= now) {
    fail("prepared artifact receipt is expired");
  }
  if (expiresAt <= createdAt || expiresAt - createdAt > 24 * 60 * 60 * 1000) {
    fail("receipt validity window is invalid");
  }
  const actual = treeDigest(app, true);
  if (actual !== receipt.artifact.treeSha256) {
    fail(`artifact tree digest mismatch: expected=${receipt.artifact.treeSha256} actual=${actual}`);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} else {
  fail("usage: <hash-tree|create|verify> ...");
}
