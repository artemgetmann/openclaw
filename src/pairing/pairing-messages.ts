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

function isJarvisConsumerTelegramPairing(
  channel: PairingChannel,
  env: Record<string, string | undefined>,
): boolean {
  if (channel !== "telegram") {
    return false;
  }
  const appVariant = env.OPENCLAW_APP_VARIANT?.trim().toLowerCase();
  if (appVariant === "consumer") {
    return true;
  }
  const profile = env.OPENCLAW_PROFILE?.trim().toLowerCase() ?? "";
  if (profile.includes("jarvis-consumer")) {
    return true;
  }
  const instanceId = env.OPENCLAW_CONSUMER_INSTANCE_ID?.trim();
  return Boolean(instanceId);
}

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  env?: Record<string, string | undefined>;
}): string {
  const { channel, idLine, code, env } = params;
  if (isJarvisConsumerTelegramPairing(channel, env ?? process.env)) {
    return ["Jarvis is ready to approve this chat.", "", idLine, "", "Return to Jarvis."].join(
      "\n",
    );
  }

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
