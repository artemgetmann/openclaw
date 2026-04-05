import { parseExecArgvToken } from "./exec-approvals-analysis.js";
import {
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  type SafeBinValueGuard,
  type SafeBinProfile,
} from "./exec-safe-bin-policy-profiles.js";

function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "-") {
    return false;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

function hasGlobToken(value: string): boolean {
  // Safe bins are stdin-only; globbing is both surprising and a historical bypass vector.
  // Note: we still harden execution-time expansion separately.
  return /[*?[\]]/.test(value);
}

const NO_FLAGS: ReadonlySet<string> = new Set();
const NO_GUARDED_VALUE_FLAGS: ReadonlyMap<string, SafeBinValueGuard> = new Map();

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function isInvalidValueToken(value: string | undefined): boolean {
  return !value || !isSafeLiteralToken(value);
}

function validateGuardedValue(value: string | undefined, guard: SafeBinValueGuard): boolean {
  if (guard === "forbid") {
    return false;
  }
  if (guard === "stdinOnly") {
    return value === "-";
  }
  return !isInvalidValueToken(value);
}

function matchesCommandFamily(
  positional: readonly string[],
  commandFamilies: readonly (readonly string[])[],
): boolean {
  return commandFamilies.some(
    (family) =>
      family.length <= positional.length &&
      family.every((token, index) => positional[index]?.toLowerCase() === token),
  );
}

function isPotentialOptionValueToken(value: string | undefined): value is string {
  if (!value || value === "--") {
    return false;
  }
  const token = parseExecArgvToken(value);
  return token.kind === "positional" || token.kind === "stdin";
}

function resolveCanonicalLongFlag(params: {
  flag: string;
  knownLongFlagsSet: ReadonlySet<string>;
  longFlagPrefixMap: ReadonlyMap<string, string | null>;
}): string | null {
  if (!params.flag.startsWith("--") || params.flag.length <= 2) {
    return null;
  }
  if (params.knownLongFlagsSet.has(params.flag)) {
    return params.flag;
  }
  return params.longFlagPrefixMap.get(params.flag) ?? null;
}

function consumeLongOptionToken(params: {
  args: string[];
  index: number;
  flag: string;
  inlineValue: string | undefined;
  allowedFlags: ReadonlySet<string>;
  allowedValueFlags: ReadonlySet<string>;
  deniedFlags: ReadonlySet<string>;
  guardedValueFlags: ReadonlyMap<string, SafeBinValueGuard>;
  knownLongFlagsSet: ReadonlySet<string>;
  longFlagPrefixMap: ReadonlyMap<string, string | null>;
  allowUnknownOptions: boolean;
}): number {
  const canonicalFlag = resolveCanonicalLongFlag({
    flag: params.flag,
    knownLongFlagsSet: params.knownLongFlagsSet,
    longFlagPrefixMap: params.longFlagPrefixMap,
  });
  if (!canonicalFlag) {
    if (!params.allowUnknownOptions) {
      return -1;
    }
    if (params.inlineValue !== undefined) {
      return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
    }
    const nextRaw = params.args[params.index + 1];
    if (!isPotentialOptionValueToken(nextRaw)) {
      return params.index + 1;
    }
    return isSafeLiteralToken(nextRaw) ? params.index + 2 : -1;
  }
  if (params.deniedFlags.has(canonicalFlag)) {
    return -1;
  }
  const valueGuard = params.guardedValueFlags.get(canonicalFlag);
  const allowsBareFlag = params.allowedFlags.has(canonicalFlag);
  const expectsValue = params.allowedValueFlags.has(canonicalFlag);
  if (params.inlineValue !== undefined) {
    if (valueGuard) {
      return validateGuardedValue(params.inlineValue, valueGuard) ? params.index + 1 : -1;
    }
    if (!expectsValue) {
      return -1;
    }
    return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
  }
  if (allowsBareFlag) {
    return params.index + 1;
  }
  if (valueGuard) {
    return validateGuardedValue(params.args[params.index + 1], valueGuard) ? params.index + 2 : -1;
  }
  if (!expectsValue) {
    return params.allowUnknownOptions ? params.index + 1 : -1;
  }
  return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
}

function consumeShortOptionClusterToken(params: {
  args: string[];
  index: number;
  cluster: string;
  flags: string[];
  allowedValueFlags: ReadonlySet<string>;
  deniedFlags: ReadonlySet<string>;
}): number {
  for (let j = 0; j < params.flags.length; j += 1) {
    const flag = params.flags[j];
    if (params.deniedFlags.has(flag)) {
      return -1;
    }
    if (!params.allowedValueFlags.has(flag)) {
      continue;
    }
    const inlineValue = params.cluster.slice(j + 1);
    if (inlineValue) {
      return isSafeLiteralToken(inlineValue) ? params.index + 1 : -1;
    }
    return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
  }
  return -1;
}

function consumePositionalToken(token: string, positional: string[]): boolean {
  if (!isSafeLiteralToken(token)) {
    return false;
  }
  positional.push(token);
  return true;
}

function validatePositionalCount(positional: string[], profile: SafeBinProfile): boolean {
  const minPositional = profile.minPositional ?? 0;
  if (positional.length < minPositional) {
    return false;
  }
  return typeof profile.maxPositional !== "number" || positional.length <= profile.maxPositional;
}

export function validateSafeBinArgv(args: string[], profile: SafeBinProfile): boolean {
  const allowedFlags = profile.allowedFlags ?? NO_FLAGS;
  const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
  const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
  const guardedValueFlags = profile.guardedValueFlags ?? NO_GUARDED_VALUE_FLAGS;
  const commandFamilies = profile.commandFamilies ?? [];
  const allowUnknownOptions = profile.allowUnknownOptions === true && commandFamilies.length > 0;
  const knownLongFlags =
    profile.knownLongFlags ??
    collectKnownLongFlags(allowedFlags, allowedValueFlags, deniedFlags, guardedValueFlags);
  const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
  const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);

  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const rawToken = args[i] ?? "";
    const token = parseExecArgvToken(rawToken);

    if (token.kind === "empty" || token.kind === "stdin") {
      i += 1;
      continue;
    }

    if (token.kind === "terminator") {
      for (let j = i + 1; j < args.length; j += 1) {
        const rest = args[j];
        if (!rest || rest === "-") {
          continue;
        }
        if (!consumePositionalToken(rest, positional)) {
          return false;
        }
      }
      break;
    }

    if (token.kind === "positional") {
      if (!consumePositionalToken(token.raw, positional)) {
        return false;
      }
      i += 1;
      continue;
    }

    if (token.style === "long") {
      const nextIndex = consumeLongOptionToken({
        args,
        index: i,
        flag: token.flag,
        inlineValue: token.inlineValue,
        allowedFlags,
        allowedValueFlags,
        deniedFlags,
        guardedValueFlags,
        knownLongFlagsSet,
        longFlagPrefixMap,
        allowUnknownOptions,
      });
      if (nextIndex < 0) {
        return false;
      }
      i = nextIndex;
      continue;
    }

    const nextIndex = consumeShortOptionClusterToken({
      args,
      index: i,
      cluster: token.cluster,
      flags: token.flags,
      allowedValueFlags,
      deniedFlags,
    });
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  if (!validatePositionalCount(positional, profile)) {
    return false;
  }
  if (commandFamilies.length === 0) {
    return true;
  }
  return matchesCommandFamily(positional, commandFamilies);
}
