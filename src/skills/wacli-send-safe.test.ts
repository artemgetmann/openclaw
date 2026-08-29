import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSendArgs,
  parseArgs,
  readOutboundTextStream,
  resolveOutboundText,
  runOwnerSafeSend,
  type Flags,
} from "../../skills/wacli/scripts/wacli-send-safe.js";

const tempRoots: string[] = [];

function baseFlags(overrides: Partial<Flags> = {}): Flags {
  return {
    command: "text",
    graceMs: 5_000,
    json: true,
    lockWaitMs: 1_000,
    message: "hello",
    settleMs: 1,
    storeDir: "/tmp/wacli-test-store",
    timeoutMs: 1_000,
    to: "+15550001111",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("wacli safe-send text input", () => {
  it("accepts exactly one message source for text sends", () => {
    expect(parseArgs(["text", "--to", "+15550001111", "--message-file", "-"])).toMatchObject({
      command: "text",
      messageFile: "-",
    });

    expect(() =>
      parseArgs(["text", "--to", "+15550001111", "--message", "hello", "--message-file", "-"]),
    ).toThrow(/only one of --message or --message-file/i);
  });

  it("accepts exactly one caption source for file sends", () => {
    expect(
      parseArgs([
        "file",
        "--to",
        "+15550001111",
        "--file",
        "/tmp/proof.pdf",
        "--caption-file",
        "-",
      ]),
    ).toMatchObject({ captionFile: "-", command: "file" });

    expect(() =>
      parseArgs([
        "file",
        "--to",
        "+15550001111",
        "--file",
        "/tmp/proof.pdf",
        "--caption",
        "hello",
        "--caption-file",
        "-",
      ]),
    ).toThrow(/only one of --caption or --caption-file/i);
  });

  it("preserves multiline stdin, Unicode chunk boundaries, and literal escapes", async () => {
    const encoded = Buffer.from("Heading\n\n🦞 literal \\n remains literal\n", "utf8");
    const splitInsideEmoji = encoded.indexOf(Buffer.from("🦞")) + 2;
    const stdin = Readable.from([
      encoded.subarray(0, splitInsideEmoji),
      encoded.subarray(splitInsideEmoji),
    ]);

    const resolved = await resolveOutboundText(
      baseFlags({ message: undefined, messageFile: "-" }),
      stdin,
    );

    expect(resolved.message).toBe("Heading\n\n🦞 literal \\n remains literal\n");
    expect(buildSendArgs(resolved)).toEqual([
      "--store",
      "/tmp/wacli-test-store",
      "send",
      "text",
      "--to",
      "+15550001111",
      "--message",
      "Heading\n\n🦞 literal \\n remains literal\n",
    ]);
    expect(buildSendArgs(resolved)).not.toContain("--message-escapes");
  });

  it("reads file-backed captions exactly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-caption-"));
    tempRoots.push(root);
    const captionFile = path.join(root, "caption.txt");
    fs.writeFileSync(captionFile, "Caption\n\nLiteral \\n\n", "utf8");

    const resolved = await resolveOutboundText(
      baseFlags({
        captionFile,
        command: "file",
        file: "/tmp/proof.pdf",
        message: undefined,
      }),
    );

    expect(resolved.caption).toBe("Caption\n\nLiteral \\n\n");
    expect(buildSendArgs(resolved)).toContain("Caption\n\nLiteral \\n\n");
  });

  it("rejects inline multiline and JSON-style escapes before taking the store lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-reject-"));
    tempRoots.push(root);
    const runCommand = vi.fn();
    const lockDir = path.join(root, ".openclaw-send-safe.lock");

    await expect(
      runOwnerSafeSend(baseFlags({ message: String.raw`Heading\n\n- item`, storeDir: root }), {
        runCommand,
      }),
    ).rejects.toThrow(/use --message-file/i);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(lockDir)).toBe(false);

    await expect(resolveOutboundText(baseFlags({ message: "Heading\n\n- item" }))).rejects.toThrow(
      /use --message-file/i,
    );
    await expect(
      resolveOutboundText(baseFlags({ message: JSON.stringify('He said "yes"').slice(1, -1) })),
    ).rejects.toThrow(/use --message-file/i);
  });

  it("rejects empty, NUL, and oversized file input", async () => {
    await expect(readOutboundTextStream(Readable.from(["  \n"]), "test input")).rejects.toThrow(
      /empty/i,
    );
    await expect(readOutboundTextStream(Readable.from(["a\0b"]), "test input")).rejects.toThrow(
      /NUL/i,
    );
    await expect(
      readOutboundTextStream(
        Readable.from([Buffer.alloc(64 * 1024, "a"), Buffer.from("b")]),
        "test input",
      ),
    ).rejects.toThrow(/64 KiB/i);
    await expect(
      readOutboundTextStream(Readable.from([Buffer.from([0x66, 0x80, 0x6f])]), "test input"),
    ).rejects.toThrow(/valid UTF-8/i);
  });
});
