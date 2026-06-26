#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_INSTALL_KINDS = new Set(["brew", "node", "go", "uv", "download"]);

function usage() {
  console.error(
    [
      "Usage: scripts/consumer-capabilities-manifest.mjs <skills-dir> [--out <path>] [--check-local-drift] [--fail-on-local-drift]",
      "",
      "Writes a deterministic manifest of packaged skill hashes and managed CLI version expectations.",
      "When --check-local-drift is set, local installed tool versions newer than packaged recommendedVersion are reported.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const skillsDir = args.shift();
  const options = {
    skillsDir,
    outPath: undefined,
    checkLocalDrift: false,
    failOnLocalDrift: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--out": {
        const value = args.shift();
        if (!value) {
          throw new Error("--out requires a path");
        }
        options.outPath = value;
        break;
      }
      case "--check-local-drift":
        options.checkLocalDrift = true;
        break;
      case "--fail-on-local-drift":
        options.failOnLocalDrift = true;
        options.checkLocalDrift = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.skillsDir) {
    throw new Error("missing skills directory");
  }
  return options;
}

function assertSafeSkillName(skillName) {
  if (!skillName || skillName.includes("/") || skillName.includes("\\")) {
    throw new Error(`invalid skill name: ${JSON.stringify(skillName)}`);
  }
}

function listSkillNames(skillsDir) {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((skillName) => fs.existsSync(path.join(skillsDir, skillName, "SKILL.md")))
    .toSorted((a, b) => a.localeCompare(b));
}

function walkFiles(rootDir) {
  const files = [];

  function visit(currentDir, relativeRoot = "") {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .toSorted((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relativePath });
      }
    }
  }

  visit(rootDir);
  return files;
}

export function hashSkillDirectory(skillDir) {
  const hash = crypto.createHash("sha256");
  const files = walkFiles(skillDir);

  // Include file names and content with unambiguous separators. This mirrors
  // the existing skill-content manifest behavior while keeping this script
  // standalone for release packaging.
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file.fullPath));
    hash.update("\0");
  }

  return {
    sha256: hash.digest("hex"),
    files: files.length,
  };
}

function readSkillMarkdown(skillsDir, skillName) {
  assertSafeSkillName(skillName);
  const skillPath = path.join(skillsDir, skillName, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    throw new Error(`skill markdown missing: ${skillPath}`);
  }
  return fs.readFileSync(skillPath, "utf8");
}

function extractFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return "";
  }
  const end = markdown.indexOf("\n---", 4);
  return end >= 0 ? markdown.slice(4, end) : "";
}

function frontmatterScalar(frontmatter, key) {
  const pattern = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const match = frontmatter.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  const raw = match[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function readBalancedSegment(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return undefined;
}

function extractJsonishObjectsFromArray(frontmatter, key) {
  const keyIndex = frontmatter.indexOf(`"${key}"`);
  if (keyIndex < 0) {
    return [];
  }
  const arrayStart = frontmatter.indexOf("[", keyIndex);
  if (arrayStart < 0) {
    return [];
  }
  const arrayText = readBalancedSegment(frontmatter, arrayStart, "[", "]");
  if (!arrayText) {
    return [];
  }

  const objects = [];
  for (let index = 0; index < arrayText.length; index += 1) {
    if (arrayText[index] !== "{") {
      continue;
    }
    const objectText = readBalancedSegment(arrayText, index, "{", "}");
    if (!objectText) {
      break;
    }
    objects.push(objectText);
    index += objectText.length - 1;
  }
  return objects;
}

function parseJsonishObject(objectText) {
  // Skill metadata is intentionally JSON-like but many entries use trailing
  // commas for readability. Strip only trailing commas before JSON.parse.
  return JSON.parse(objectText.replace(/,\s*([}\]])/g, "$1"));
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function normalizeInstallSpec(raw, index) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  if (typeof raw.kind !== "string" || !ALLOWED_INSTALL_KINDS.has(raw.kind)) {
    return undefined;
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `${raw.kind}-${index}`,
    kind: raw.kind,
    label: typeof raw.label === "string" ? raw.label : undefined,
    bins: normalizeStringArray(raw.bins).toSorted((a, b) => a.localeCompare(b)),
    formula: typeof raw.formula === "string" ? raw.formula : undefined,
    package: typeof raw.package === "string" ? raw.package : undefined,
    module: typeof raw.module === "string" ? raw.module : undefined,
    versionCommand: normalizeStringArray(raw.versionCommand),
    versionRegex: typeof raw.versionRegex === "string" ? raw.versionRegex : undefined,
    minVersion: typeof raw.minVersion === "string" ? raw.minVersion : undefined,
    recommendedVersion:
      typeof raw.recommendedVersion === "string" ? raw.recommendedVersion : undefined,
  };
}

function extractInstallSpecs(frontmatter) {
  return extractJsonishObjectsFromArray(frontmatter, "install")
    .map((objectText) => {
      try {
        return parseJsonishObject(objectText);
      } catch {
        return undefined;
      }
    })
    .map(normalizeInstallSpec)
    .filter(Boolean);
}

function extractDisplayName(frontmatter) {
  const match = frontmatter.match(/"displayName"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

export function buildConsumerCapabilitiesManifest(skillsDirArg) {
  const skillsDir = path.resolve(skillsDirArg);
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    throw new Error(`skills directory missing: ${skillsDir}`);
  }

  const skills = {};
  const managedTools = [];

  for (const skillName of listSkillNames(skillsDir)) {
    const skillDir = path.join(skillsDir, skillName);
    const markdown = readSkillMarkdown(skillsDir, skillName);
    const frontmatter = extractFrontmatter(markdown);
    const install = extractInstallSpecs(frontmatter);
    const hash = hashSkillDirectory(skillDir);

    skills[skillName] = {
      ...hash,
      ...(frontmatterScalar(frontmatter, "description")
        ? { description: frontmatterScalar(frontmatter, "description") }
        : {}),
      ...(frontmatterScalar(frontmatter, "homepage")
        ? { homepage: frontmatterScalar(frontmatter, "homepage") }
        : {}),
      ...(extractDisplayName(frontmatter) ? { displayName: extractDisplayName(frontmatter) } : {}),
    };

    for (const spec of install) {
      const hasVersionExpectation =
        spec.versionCommand.length > 0 || spec.minVersion || spec.recommendedVersion;
      if (!hasVersionExpectation) {
        continue;
      }
      managedTools.push({
        skillName,
        installId: spec.id,
        kind: spec.kind,
        ...(spec.label ? { label: spec.label } : {}),
        ...(spec.bins.length > 0 ? { bins: spec.bins } : {}),
        ...(spec.formula ? { formula: spec.formula } : {}),
        ...(spec.package ? { package: spec.package } : {}),
        ...(spec.module ? { module: spec.module } : {}),
        ...(spec.versionCommand.length > 0 ? { versionCommand: spec.versionCommand } : {}),
        ...(spec.versionRegex ? { versionRegex: spec.versionRegex } : {}),
        ...(spec.minVersion ? { minVersion: spec.minVersion } : {}),
        ...(spec.recommendedVersion ? { recommendedVersion: spec.recommendedVersion } : {}),
      });
    }
  }

  managedTools.sort((left, right) =>
    `${left.skillName}:${left.installId}`.localeCompare(`${right.skillName}:${right.installId}`),
  );

  return {
    format: 1,
    skills,
    managedTools,
  };
}

function parseVersionParts(version) {
  return String(version)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function extractVersion(output, versionRegex) {
  const pattern = versionRegex
    ? new RegExp(versionRegex)
    : /v?(\d+(?:\.\d+)+(?:[-.][0-9A-Za-z]+)?)/;
  const match = output.match(pattern);
  return match?.groups?.version ?? match?.[1];
}

function commandExists(bin) {
  const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function collectLocalCapabilityDrift(manifest) {
  const issues = [];

  for (const tool of manifest.managedTools ?? []) {
    const command = Array.isArray(tool.versionCommand) ? tool.versionCommand : [];
    if (command.length === 0 || !tool.recommendedVersion) {
      continue;
    }
    const [bin, ...args] = command;
    if (!bin || !commandExists(bin)) {
      continue;
    }
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const localVersion = output ? extractVersion(output, tool.versionRegex) : undefined;
    if (!localVersion) {
      continue;
    }
    if (compareVersions(localVersion, tool.recommendedVersion) > 0) {
      issues.push({
        skillName: tool.skillName,
        installId: tool.installId,
        bin,
        localVersion,
        packagedRecommendedVersion: tool.recommendedVersion,
      });
    }
  }

  return issues;
}

function printDriftIssues(issues, stream = process.stderr) {
  for (const issue of issues) {
    stream.write(
      [
        `local tool is newer than packaged release metadata: ${issue.bin}`,
        `  skill=${issue.skillName}`,
        `  install=${issue.installId}`,
        `  local_version=${issue.localVersion}`,
        `  packaged_recommended_version=${issue.packagedRecommendedVersion}`,
        "  Update the skill install metadata before packaging, or set OPENCLAW_CONSUMER_ALLOW_CAPABILITY_DRIFT=1 for an intentional override.",
        "",
      ].join("\n"),
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = buildConsumerCapabilitiesManifest(options.skillsDir);
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    fs.writeFileSync(options.outPath, rendered);
  } else {
    process.stdout.write(rendered);
  }

  if (options.checkLocalDrift) {
    const issues = collectLocalCapabilityDrift(manifest);
    if (issues.length > 0) {
      printDriftIssues(issues);
      if (
        options.failOnLocalDrift &&
        process.env.OPENCLAW_CONSUMER_ALLOW_CAPABILITY_DRIFT !== "1"
      ) {
        process.exit(1);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
