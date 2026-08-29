import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { getSubCliEntries } from "./program/subcli-descriptors.js";
import { buildWhatsAppSafeSendArgs, registerWhatsAppUserCli } from "./whatsapp-user-cli.js";

describe("whatsapp-user cli", () => {
  it("builds the bundled safe-send argv without putting generated text inline", () => {
    expect(
      buildWhatsAppSafeSendArgs("text", {
        json: true,
        messageFile: "-",
        to: "+15550001111",
      }),
    ).toEqual(["text", "--to", "+15550001111", "--message-file", "-", "--json"]);

    expect(
      buildWhatsAppSafeSendArgs("file", {
        captionFile: "-",
        file: "/tmp/proof.pdf",
        to: "+15550001111",
      }),
    ).toEqual(["file", "--to", "+15550001111", "--file", "/tmp/proof.pdf", "--caption-file", "-"]);
  });

  it("registers the exact stdin-backed message and caption flags", () => {
    const program = new Command();
    program.exitOverride();
    registerWhatsAppUserCli(program);

    const help = program.commands
      .find((command) => command.name() === "whatsapp-user")
      ?.commands.find((command) => command.name() === "send-text")
      ?.helpInformation();

    expect(help).toContain("--message-file <path>");
    expect(help).toContain("--caption-file <path>");
    expect(getSubCliEntries()).toContainEqual({
      name: "whatsapp-user",
      description: "WhatsApp-as-me owner-safe messaging",
      hasSubcommands: true,
    });
  });
});
