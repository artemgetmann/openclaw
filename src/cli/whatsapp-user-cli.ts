import { spawn } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";

type WhatsAppSafeSendOptions = {
  caption?: string;
  captionFile?: string;
  file?: string;
  graceMs?: string;
  json?: boolean;
  lockWaitMs?: string;
  message?: string;
  messageFile?: string;
  settleMs?: string;
  store?: string;
  timeoutMs?: string;
  to: string;
};

export function buildWhatsAppSafeSendArgs(kind: string, opts: WhatsAppSafeSendOptions): string[] {
  if (kind !== "text" && kind !== "file") {
    throw new Error("WhatsApp user send kind must be text or file.");
  }
  const args = [kind, "--to", opts.to];
  const valueFlags: Array<[string, string | undefined]> = [
    ["--message", opts.message],
    ["--message-file", opts.messageFile],
    ["--file", opts.file],
    ["--caption", opts.caption],
    ["--caption-file", opts.captionFile],
    ["--store", opts.store],
    ["--timeout-ms", opts.timeoutMs],
    ["--lock-wait-ms", opts.lockWaitMs],
    ["--settle-ms", opts.settleMs],
    ["--grace-ms", opts.graceMs],
  ];
  for (const [flag, value] of valueFlags) {
    if (value !== undefined) {
      args.push(flag, value);
    }
  }
  if (opts.json) {
    args.push("--json");
  }
  return args;
}

async function runBundledWhatsAppSafeSend(args: string[]): Promise<void> {
  const bundledSkillsDir = resolveBundledSkillsDir({ allowEnvOverride: false });
  if (!bundledSkillsDir) {
    throw new Error("Bundled skills directory is unavailable.");
  }
  // Resolve the trusted bundled helper ourselves. Agents invoke the product CLI,
  // so they do not need executable approval for a writable workspace script.
  const helper = path.join(bundledSkillsDir, "wacli", "scripts", "wacli-send-safe.sh");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `WhatsApp safe send exited on signal ${signal}.`
            : `WhatsApp safe send exited with code ${String(code)}.`,
        ),
      );
    });
  });
}

export function registerWhatsAppUserCli(program: Command): void {
  const whatsappUser = program
    .command("whatsapp-user")
    .description("WhatsApp-as-me owner-safe messaging")
    .action(() => whatsappUser.help({ error: true }));

  const registerSend = (name: "send-text" | "send-file", kind: "text" | "file") =>
    whatsappUser
      .command(name)
      .description(`Send ${kind} through the bundled owner-safe wacli helper`)
      .requiredOption("--to <recipient>", "Phone number or WhatsApp JID")
      .option("--message <text>", "Simple one-line text for deliberate human use")
      .option("--message-file <path>", "Read exact text from a UTF-8 file; use - for stdin")
      .option("--file <path>", "File to send")
      .option("--caption <text>", "Simple one-line caption for deliberate human use")
      .option("--caption-file <path>", "Read exact caption from a UTF-8 file; use - for stdin")
      .option("--store <dir>", "wacli store directory")
      .option("--timeout-ms <ms>", "Raw command timeout")
      .option("--lock-wait-ms <ms>", "Safe-send lock wait")
      .option("--settle-ms <ms>", "Post-send settle window")
      .option("--grace-ms <ms>", "History reconciliation grace window")
      .option("--json", "Output JSON", false)
      .action(async (opts: WhatsAppSafeSendOptions) => {
        await runBundledWhatsAppSafeSend(buildWhatsAppSafeSendArgs(kind, opts));
      });

  registerSend("send-text", "text");
  registerSend("send-file", "file");
}
