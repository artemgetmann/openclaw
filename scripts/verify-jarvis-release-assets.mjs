#!/usr/bin/env node

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DMG_URL =
  "https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.dmg";
const DEFAULT_ZIP_URL =
  "https://github.com/artemgetmann/openclaw/releases/latest/download/Jarvis.zip";
const DEFAULT_APPCAST_URL =
  "https://github.com/artemgetmann/openclaw/releases/latest/download/jarvis-appcast.xml";
const MAX_REDIRECTS = 10;
const MAX_APPCAST_BYTES = 1024 * 1024;

function usage() {
  return [
    "Usage: node scripts/verify-jarvis-release-assets.mjs --app-path <dist/Jarvis.app> --zip-path <dist/Jarvis.zip> [--dmg-url <url>] [--zip-url <url>] [--appcast-url <url>]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    appPath: null,
    zipPath: null,
    dmgUrl: DEFAULT_DMG_URL,
    zipUrl: DEFAULT_ZIP_URL,
    appcastUrl: DEFAULT_APPCAST_URL,
  };

  const valueOptions = new Map([
    ["--app-path", "appPath"],
    ["--zip-path", "zipPath"],
    ["--dmg-url", "dmgUrl"],
    ["--zip-url", "zipUrl"],
    ["--appcast-url", "appcastUrl"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = valueOptions.get(arg);
    if (!key) {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}\n${usage()}`);
    }
    options[key] = value;
    index += 1;
  }

  if (!options.appPath) {
    throw new Error(`missing required --app-path\n${usage()}`);
  }
  if (!options.zipPath) {
    throw new Error(`missing required --zip-path\n${usage()}`);
  }

  return options;
}

async function readPlistValue(plistPath, key) {
  try {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      plistPath,
    ]);
    const value = stdout.trim();
    if (!value) {
      throw new Error(`empty ${key}`);
    }
    return value;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`could not read ${key} from ${plistPath}: ${detail}`, { cause: error });
  }
}

async function readAppVersions(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  await stat(plistPath);

  const [bundleVersion, shortVersion] = await Promise.all([
    readPlistValue(plistPath, "CFBundleVersion"),
    readPlistValue(plistPath, "CFBundleShortVersionString"),
  ]);

  return { bundleVersion, shortVersion };
}

function requestUrl(urlText, { method, collectBody, redirectCount = 0 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    let url;
    try {
      url = new URL(urlText);
    } catch {
      fail(new Error(`invalid URL: ${urlText}`));
      return;
    }

    const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!transport) {
      fail(new Error(`unsupported URL protocol for ${urlText}`));
      return;
    }

    const req = transport.request(
      url,
      {
        method,
        headers: {
          "User-Agent": "jarvis-release-asset-verifier",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const redirectLocation = res.headers.location;

        // GitHub release download URLs redirect through multiple hosts. Keep the
        // check public by following redirects without auth or API calls.
        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          typeof redirectLocation === "string"
        ) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            fail(new Error(`too many redirects for ${urlText}`));
            return;
          }
          const redirectedUrl = new URL(redirectLocation, url).toString();
          requestUrl(redirectedUrl, {
            method,
            collectBody,
            redirectCount: redirectCount + 1,
          })
            .then(finish)
            .catch(fail);
          return;
        }

        if (!collectBody) {
          // HEAD is preferred for large DMG/ZIP artifacts. If a caller falls
          // back to GET, resolve from headers and drain the payload so a forced
          // socket close does not look like a failed public URL.
          res.on("error", () => {});
          finish({ statusCode, headers: res.headers, finalUrl: url.toString(), body: "" });
          res.resume();
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_APPCAST_BYTES) {
            fail(new Error(`appcast response exceeds ${MAX_APPCAST_BYTES} bytes`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          finish({
            statusCode,
            headers: res.headers,
            finalUrl: url.toString(),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", fail);
    req.end();
  });
}

async function verifyUrlOk(label, url, { collectBody = false } = {}) {
  let response = await requestUrl(url, { method: collectBody ? "GET" : "HEAD", collectBody });

  // Some public hosts reject HEAD even when the asset is downloadable. Avoid
  // pulling large files unless the server explicitly tells us HEAD is invalid.
  if (!collectBody && [405, 501].includes(response.statusCode)) {
    response = await requestUrl(url, { method: "GET", collectBody: false });
  }

  if (response.statusCode !== 200) {
    throw new Error(`${label} URL returned HTTP ${response.statusCode}: ${url}`);
  }

  return response;
}

function parseContentLength(headers, label, { required = false } = {}) {
  const raw = headers["content-length"];
  if (raw === undefined) {
    if (required) {
      throw new Error(`${label} response missing content-length`);
    }
    return null;
  }

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} response has invalid content-length: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function decodeXmlValue(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function extractChannelXml(appcastXml) {
  const match = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(appcastXml);
  if (!match) {
    throw new Error("appcast XML missing channel element");
  }
  return match[1];
}

function extractChannelTitle(channelXml) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(channelXml);
  if (!match) {
    throw new Error("appcast channel missing title");
  }
  return decodeXmlValue(match[1].trim());
}

function extractFirstItemXml(channelXml) {
  const match = /<item\b[^>]*>([\s\S]*?)<\/item>/i.exec(channelXml);
  if (!match) {
    throw new Error("appcast channel missing item element");
  }
  return match[1];
}

function extractXmlElementValue(xml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedName}>`, "i");
  const match = regex.exec(xml);
  if (!match) {
    throw new Error(`appcast item missing ${name}`);
  }

  const value = decodeXmlValue(match[1].trim());
  if (!value) {
    throw new Error(`appcast item has empty ${name}`);
  }
  return value;
}

function parseXmlAttributes(attributeText) {
  const attributes = new Map();
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of attributeText.matchAll(regex)) {
    attributes.set(match[1], decodeXmlValue(match[2] ?? match[3] ?? ""));
  }
  return attributes;
}

function extractEnclosureAttributes(itemXml) {
  const match = /<enclosure\b([\s\S]*?)(?:\/>|>)/i.exec(itemXml);
  if (!match) {
    throw new Error("appcast item missing enclosure element");
  }

  // Sparkle stores update facts as namespaced attributes on enclosure. A small
  // attribute parser is enough here and avoids adding a release-time dependency.
  return parseXmlAttributes(match[1]);
}

function requireAttribute(attributes, name) {
  const value = attributes.get(name);
  if (!value || !value.trim()) {
    throw new Error(`appcast enclosure missing ${name}`);
  }
  return value.trim();
}

function verifyAppcast(appcastXml, { bundleVersion, shortVersion, zipUrl, zipSize }) {
  const channelXml = extractChannelXml(appcastXml);
  const title = extractChannelTitle(channelXml);
  if (title !== "Jarvis") {
    throw new Error(`appcast channel title mismatch: expected Jarvis, got ${title}`);
  }

  const itemXml = extractFirstItemXml(channelXml);
  const appcastVersion = extractXmlElementValue(itemXml, "sparkle:version");
  const appcastShortVersion = extractXmlElementValue(itemXml, "sparkle:shortVersionString");
  const enclosure = extractEnclosureAttributes(itemXml);
  const enclosureUrl = requireAttribute(enclosure, "url");
  const enclosureLengthRaw = requireAttribute(enclosure, "length");
  const edSignature = requireAttribute(enclosure, "sparkle:edSignature");

  if (appcastVersion !== bundleVersion) {
    throw new Error(
      `appcast sparkle:version mismatch: expected ${bundleVersion}, got ${appcastVersion}`,
    );
  }
  if (appcastShortVersion !== shortVersion) {
    throw new Error(
      `appcast sparkle:shortVersionString mismatch: expected ${shortVersion}, got ${appcastShortVersion}`,
    );
  }
  if (enclosureUrl !== zipUrl) {
    throw new Error(`appcast enclosure url mismatch: expected ${zipUrl}, got ${enclosureUrl}`);
  }
  if (!/^[0-9]+$/.test(enclosureLengthRaw)) {
    throw new Error(`appcast enclosure length is invalid: ${enclosureLengthRaw}`);
  }

  const enclosureLength = Number.parseInt(enclosureLengthRaw, 10);
  if (enclosureLength !== zipSize) {
    throw new Error(
      `appcast enclosure length mismatch: expected ${zipSize}, got ${enclosureLength}`,
    );
  }

  return {
    title,
    appcastVersion,
    appcastShortVersion,
    enclosureLength,
    edSignatureLength: edSignature.length,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const appPath = path.resolve(options.appPath);
  const zipPath = path.resolve(options.zipPath);
  const zipStats = await stat(zipPath);
  if (!zipStats.isFile()) {
    throw new Error(`zip path is not a file: ${zipPath}`);
  }

  const versions = await readAppVersions(appPath);
  console.log(
    `app_versions_ok bundle_version=${versions.bundleVersion} short_version=${versions.shortVersion}`,
  );

  const dmgResponse = await verifyUrlOk("dmg", options.dmgUrl);
  console.log(
    `public_asset_ok kind=dmg status=200 content_length=${parseContentLength(dmgResponse.headers, "dmg") ?? "absent"}`,
  );

  const zipResponse = await verifyUrlOk("zip", options.zipUrl);
  const publicZipLength = parseContentLength(zipResponse.headers, "zip");
  if (publicZipLength !== null && publicZipLength !== zipStats.size) {
    throw new Error(
      `zip content-length mismatch: expected ${zipStats.size}, got ${publicZipLength}`,
    );
  }
  console.log(
    `public_asset_ok kind=zip status=200 local_size=${zipStats.size} content_length=${publicZipLength ?? "absent"}`,
  );

  const appcastResponse = await verifyUrlOk("appcast", options.appcastUrl, { collectBody: true });
  console.log(
    `public_asset_ok kind=appcast status=200 content_length=${parseContentLength(appcastResponse.headers, "appcast") ?? "absent"}`,
  );

  const appcastProof = verifyAppcast(appcastResponse.body, {
    bundleVersion: versions.bundleVersion,
    shortVersion: versions.shortVersion,
    zipUrl: options.zipUrl,
    zipSize: zipStats.size,
  });
  console.log(
    `appcast_ok title=${appcastProof.title} sparkle_version=${appcastProof.appcastVersion} sparkle_short_version=${appcastProof.appcastShortVersion} enclosure_length=${appcastProof.enclosureLength} ed_signature_length=${appcastProof.edSignatureLength}`,
  );
  console.log("release_sendable=true");
  console.log("sparkle_update_live=true");
}

try {
  await main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
