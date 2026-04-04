import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAFE_BIN_PROFILE_FIXTURES,
  SAFE_BIN_PROFILES,
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  renderSafeBinDeniedFlagsDocBullets,
  resolveSafeBinProfiles,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

const SAFE_BIN_DOC_DENIED_FLAGS_START = '[//]: # "SAFE_BIN_DENIED_FLAGS:START"';
const SAFE_BIN_DOC_DENIED_FLAGS_END = '[//]: # "SAFE_BIN_DENIED_FLAGS:END"';

function buildDeniedFlagArgvVariants(flag: string): string[][] {
  const value = "blocked";
  if (flag.startsWith("--")) {
    return [[`${flag}=${value}`], [flag, value], [flag]];
  }
  if (flag.startsWith("-")) {
    return [[`${flag}${value}`], [flag, value], [flag]];
  }
  return [[flag]];
}

describe("exec safe bin policy grep", () => {
  const grepProfile = SAFE_BIN_PROFILES.grep;

  it("allows stdin-only grep when pattern comes from flags", () => {
    expect(validateSafeBinArgv(["-e", "needle"], grepProfile)).toBe(true);
    expect(validateSafeBinArgv(["--regexp=needle"], grepProfile)).toBe(true);
  });

  it("blocks grep positional pattern form to avoid filename ambiguity", () => {
    expect(validateSafeBinArgv(["needle"], grepProfile)).toBe(false);
  });

  it("blocks file positionals when pattern comes from -e/--regexp", () => {
    expect(validateSafeBinArgv(["-e", "SECRET", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp", "KEY", "config.py"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp=KEY", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "KEY", "--", ".env"], grepProfile)).toBe(false);
  });
});

describe("exec safe bin policy sort", () => {
  const sortProfile = SAFE_BIN_PROFILES.sort;

  it("allows stdin-only sort flags", () => {
    expect(validateSafeBinArgv(["-S", "1M"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--key=1,1"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--ke=1,1"], sortProfile)).toBe(true);
  });

  it("rejects missing or path-like values for allowed flags", () => {
    expect(validateSafeBinArgv(["--key"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--key", "./fields.txt"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["-S", "C:\\temp\\buffer"], sortProfile)).toBe(false);
  });

  it("blocks sort --compress-program in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-program=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--compress-program", "sh"], sortProfile)).toBe(false);
  });

  it("blocks denied long-option abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-prog=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], sortProfile)).toBe(false);
  });

  it("rejects unknown or ambiguous long options in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--totally-unknown=1"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--f=1"], sortProfile)).toBe(false);
  });
});

describe("exec safe bin policy wc", () => {
  const wcProfile = SAFE_BIN_PROFILES.wc;

  it("blocks wc --files0-from abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], wcProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro", "list.txt"], wcProfile)).toBe(false);
  });
});

describe("exec safe bin policy product-owned cli defaults", () => {
  it("allows bounded gog and himalaya positional usage", () => {
    const gogProfile = SAFE_BIN_PROFILES.gog;
    const himalayaProfile = SAFE_BIN_PROFILES.himalaya;
    expect(validateSafeBinArgv(["drive", "search", "test"], gogProfile)).toBe(true);
    expect(validateSafeBinArgv(["message", "list", "inbox"], himalayaProfile)).toBe(true);
  });

  it("allows real himalaya direct commands with documented flags", () => {
    const himalayaProfile = SAFE_BIN_PROFILES.himalaya;
    expect(
      validateSafeBinArgv(
        ["envelope", "list", "-a", "work", "--folder", "INBOX", "--page", "1", "--page-size", "20"],
        himalayaProfile,
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(["message", "write", "-H", "To:recipient@example.com"], himalayaProfile),
    ).toBe(true);
  });

  it("allows gog auth and read probes that need explicit flags", () => {
    const gogProfile = SAFE_BIN_PROFILES.gog;
    expect(
      validateSafeBinArgv(
        [
          "auth",
          "add",
          "artemnaumenko1@gmail.com",
          "--services",
          "gmail,calendar",
          "--timeout",
          "5m",
        ],
        gogProfile,
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["gmail", "search", "newer_than:7d", "--max", "10", "--json"],
        gogProfile,
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["gmail", "send", "--to", "a@b.com", "--subject", "Hi", "--body-file", "-"],
        gogProfile,
      ),
    ).toBe(true);
  });

  it("allows real wacli direct commands with documented flags", () => {
    const wacliProfile = SAFE_BIN_PROFILES.wacli;
    expect(validateSafeBinArgv(["doctor"], wacliProfile)).toBe(true);
    expect(
      validateSafeBinArgv(
        [
          "messages",
          "search",
          "invoice",
          "--chat",
          "628123@s.whatsapp.net",
          "--limit",
          "20",
          "--json",
        ],
        wacliProfile,
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["send", "text", "--to", "+14155551212", "--message", "hello there"],
        wacliProfile,
      ),
    ).toBe(true);
  });

  it("still blocks path handoffs for product-owned CLIs even when the flag itself is allowed", () => {
    const gogProfile = SAFE_BIN_PROFILES.gog;
    const himalayaProfile = SAFE_BIN_PROFILES.himalaya;
    const wacliProfile = SAFE_BIN_PROFILES.wacli;
    expect(
      validateSafeBinArgv(["auth", "credentials", "--client", "./secret.json"], gogProfile),
    ).toBe(false);
    expect(
      validateSafeBinArgv(["gmail", "send", "--body-file", "/tmp/message.txt"], gogProfile),
    ).toBe(false);
    expect(
      validateSafeBinArgv(["attachment", "download", "42", "--dir", "/tmp"], himalayaProfile),
    ).toBe(false);
    expect(validateSafeBinArgv(["send", "file", "--file", "/tmp/doc.pdf"], wacliProfile)).toBe(
      false,
    );
  });

  it("still blocks product-owned CLI command lines that blow past bounded positionals", () => {
    const gogProfile = SAFE_BIN_PROFILES.gog;
    const himalayaProfile = SAFE_BIN_PROFILES.himalaya;
    const wacliProfile = SAFE_BIN_PROFILES.wacli;
    expect(
      validateSafeBinArgv(
        ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
        gogProfile,
      ),
    ).toBe(false);
    expect(
      validateSafeBinArgv(
        ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
        himalayaProfile,
      ),
    ).toBe(false);
    expect(
      validateSafeBinArgv(
        ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
        wacliProfile,
      ),
    ).toBe(false);
  });

  it("supports legacy boolean flags like --json without treating them as value-taking", () => {
    const profile = resolveSafeBinProfiles({
      wacli: {
        maxPositional: 3,
        allowedValueFlags: ["--limit", "--json"],
      },
    }).wacli;
    expect(validateSafeBinArgv(["chats", "list", "--limit", "1", "--json"], profile)).toBe(true);
    expect(validateSafeBinArgv(["chats", "list", "--json=1"], profile)).toBe(false);
  });
});
describe("exec safe bin policy token hygiene", () => {
  it("rejects path-like and glob positional tokens after the terminator", () => {
    const grepProfile = SAFE_BIN_PROFILES.grep;
    expect(validateSafeBinArgv(["-e", "needle", "--", "../secret.txt"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "needle", "--", "*.txt"], grepProfile)).toBe(false);
  });

  it("keeps stdin marker after the terminator non-positional", () => {
    const grepProfile = SAFE_BIN_PROFILES.grep;
    expect(validateSafeBinArgv(["-e", "needle", "--", "-"], grepProfile)).toBe(true);
  });
});

describe("exec safe bin policy long-option metadata", () => {
  it("precomputes long-option prefix mappings for compiled profiles", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    expect(sortProfile.knownLongFlagsSet?.has("--compress-program")).toBe(true);
    expect(sortProfile.longFlagPrefixMap?.get("--compress-prog")).toBe("--compress-program");
    expect(sortProfile.longFlagPrefixMap?.get("--f")).toBe(null);
  });

  it("preserves behavior when profile metadata is missing and rebuilt at runtime", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    const withoutMetadata = {
      ...sortProfile,
      knownLongFlags: undefined,
      knownLongFlagsSet: undefined,
      longFlagPrefixMap: undefined,
    };
    expect(validateSafeBinArgv(["--compress-prog=sh"], withoutMetadata)).toBe(false);
    expect(validateSafeBinArgv(["--totally-unknown=1"], withoutMetadata)).toBe(false);
  });

  it("builds prefix maps from collected long flags", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    const flags = collectKnownLongFlags(
      sortProfile.allowedFlags ?? new Set(),
      sortProfile.allowedValueFlags ?? new Set(),
      sortProfile.deniedFlags ?? new Set(),
    );
    const prefixMap = buildLongFlagPrefixMap(flags);
    expect(prefixMap.get("--compress-pr")).toBe("--compress-program");
    expect(prefixMap.get("--f")).toBe(null);
  });
});

describe("exec safe bin policy denied-flag matrix", () => {
  for (const [binName, fixture] of Object.entries(SAFE_BIN_PROFILE_FIXTURES)) {
    const profile = SAFE_BIN_PROFILES[binName];
    const deniedFlags = fixture.deniedFlags ?? [];
    for (const deniedFlag of deniedFlags) {
      const variants = buildDeniedFlagArgvVariants(deniedFlag);
      for (const variant of variants) {
        it(`${binName} denies ${deniedFlag} (${variant.join(" ")})`, () => {
          expect(validateSafeBinArgv(variant, profile)).toBe(false);
        });
      }
    }
  }
});

describe("exec safe bin policy docs parity", () => {
  it("keeps denied-flag docs in sync with policy fixtures", () => {
    const docsPath = path.resolve(process.cwd(), "docs/tools/exec-approvals.md");
    const docs = fs.readFileSync(docsPath, "utf8").replaceAll("\r\n", "\n");
    const start = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_START);
    const end = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const actual = docs.slice(start + SAFE_BIN_DOC_DENIED_FLAGS_START.length, end).trim();
    const expected = renderSafeBinDeniedFlagsDocBullets();
    expect(actual).toBe(expected);
  });
});
