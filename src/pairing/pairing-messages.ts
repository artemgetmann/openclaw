import { replaceCliName } from "../cli/cli-name.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.js";

function quoteShellValue(value: string): string {
  if (!value) {
    return "''";
  }
  if (/^[A-Za-z0-9_/:.,=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatPairingApproveCommand(
  channel: PairingChannel,
  code: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const baseCommand = replaceCliName(`openclaw pairing approve ${channel} ${code}`);
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (stateDir && configPath) {
    return `OPENCLAW_STATE_DIR=${quoteShellValue(stateDir)} OPENCLAW_CONFIG_PATH=${quoteShellValue(configPath)} ${baseCommand}`;
  }
  return formatCliCommand(`openclaw pairing approve ${channel} ${code}`, env);
}

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  env?: Record<string, string | undefined>;
}): string {
  const { channel, idLine, code, env } = params;
  const approveCommand = formatPairingApproveCommand(channel, code, env);
  return [
    "OpenClaw: access not configured.",
    "",
    idLine,
    "Pairing code:",
    "```",
    code,
    "```",
    "",
    "Ask the bot owner to approve with:",
    approveCommand,
    "```",
    approveCommand,
    "```",
  ].join("\n");
}
