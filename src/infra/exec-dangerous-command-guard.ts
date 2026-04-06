function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractShellWrapperPayload(command: string): string | null {
  const trimmed = command.trim();
  if (!/^(?:\/usr\/bin\/env\s+)?(?:(?:\/bin\/)?(?:bash|sh|zsh))\b/u.test(trimmed)) {
    return null;
  }
  const flagMatch = /\s-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/u.exec(trimmed);
  if (!flagMatch?.[1]) {
    return null;
  }
  return stripOuterQuotes(flagMatch[1]);
}

function matchesBroadRmRf(command: string): boolean {
  return /\brm\b[^\n]*\s-[^\n]*r[^\n]*f[^\n]*\s+(?:--\s+)?(?:\/(?:\s|$)|\/\*(?:\s|$)|~(?:\/\*)?(?:\s|$)|\*(?:\s|$)|\.\*(?:\s|$)|\.\.(?:\s|$)|\.(?:\s|$))/u.test(
    command,
  );
}

function matchesDestructivePsql(command: string): boolean {
  if (!/\bpsql\b/u.test(command)) {
    return false;
  }
  return /\b(?:drop|truncate|delete\s+from|alter\s+table|update\s+\S+\s+set)\b/iu.test(command);
}

function detectDangerousExecCommandInner(command: string, depth: number): string | null {
  if (depth > 3) {
    return null;
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (/(?:^|\s)(?:\/usr\/bin\/)?sudo(?:\s|$)/u.test(trimmed)) {
    return "Dangerous command blocked: sudo is not allowed here.";
  }
  if (
    /(?:^|\s)(?:shutdown|reboot|halt|poweroff)(?:\s|$)/u.test(trimmed) ||
    /\bsystemctl\s+(?:reboot|poweroff)\b/u.test(trimmed)
  ) {
    return "Dangerous command blocked: shutdown and reboot commands are not allowed here.";
  }
  if (matchesBroadRmRf(trimmed)) {
    return "Dangerous command blocked: broad rm -rf targets are not allowed here.";
  }
  if (matchesDestructivePsql(trimmed)) {
    return "Dangerous command blocked: destructive psql mutations are not allowed here.";
  }

  const shellPayload = extractShellWrapperPayload(trimmed);
  if (shellPayload) {
    return detectDangerousExecCommandInner(shellPayload, depth + 1);
  }

  return null;
}

export function detectDangerousExecCommand(command: string): string | null {
  return detectDangerousExecCommandInner(command, 0);
}
