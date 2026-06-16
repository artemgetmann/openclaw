#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [, , skillsDirArg, ...skillNameArgs] = process.argv;

if (!skillsDirArg) {
  console.error("Usage: scripts/skill-content-manifest.mjs <skills-dir> [skill-name ...]");
  process.exit(2);
}

const skillsDir = path.resolve(skillsDirArg);
if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
  console.error(`ERROR: skills directory missing: ${skillsDir}`);
  process.exit(1);
}

function listSkillNames() {
  if (skillNameArgs.length > 0) {
    return skillNameArgs.toSorted((a, b) => a.localeCompare(b));
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
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

function hashSkill(skillName) {
  if (!skillName || skillName.includes("/") || skillName.includes("\\")) {
    throw new Error(`invalid skill name: ${JSON.stringify(skillName)}`);
  }

  const skillDir = path.join(skillsDir, skillName);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error(`skill directory missing: ${skillName}`);
  }

  const hash = crypto.createHash("sha256");
  const files = walkFiles(skillDir);

  // Include the relative path before each file body so two skills with swapped
  // filenames cannot produce the same digest. The NUL separators make the stream
  // unambiguous without needing a heavier archive format.
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

try {
  const skills = {};
  for (const skillName of listSkillNames()) {
    skills[skillName] = hashSkill(skillName);
  }

  process.stdout.write(`${JSON.stringify({ format: 1, skills }, null, 2)}\n`);
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
