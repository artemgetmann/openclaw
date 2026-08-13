import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const artifactsStatusCommand = vi.fn().mockResolvedValue(undefined);
const artifactsCreatePdfCommand = vi.fn().mockResolvedValue(undefined);
const artifactsCreateDocxCommand = vi.fn().mockResolvedValue(undefined);
const artifactsCreatePptxCommand = vi.fn().mockResolvedValue(undefined);
const artifactsCreateXlsxCommand = vi.fn().mockResolvedValue(undefined);
const artifactsHtmlToPdfCommand = vi.fn().mockResolvedValue(undefined);
const artifactsDocxToPdfCommand = vi.fn().mockResolvedValue(undefined);
const artifactsPptxToPdfCommand = vi.fn().mockResolvedValue(undefined);
const artifactsRenderPdfCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/artifacts.js", () => ({
  artifactsStatusCommand,
  artifactsCreatePdfCommand,
  artifactsCreateDocxCommand,
  artifactsCreatePptxCommand,
  artifactsCreateXlsxCommand,
  artifactsHtmlToPdfCommand,
  artifactsDocxToPdfCommand,
  artifactsPptxToPdfCommand,
  artifactsRenderPdfCommand,
}));

describe("artifacts cli", () => {
  let registerArtifactsCli: (typeof import("./artifacts-cli.js"))["registerArtifactsCli"];

  beforeAll(async () => {
    ({ registerArtifactsCli } = await import("./artifacts-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("teaches artifact commands in help", async () => {
    const program = new Command();
    let help = "";
    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: (text) => {
        help += text;
      },
    });
    registerArtifactsCli(program);

    await expect(program.parseAsync(["artifacts", "--help"], { from: "user" })).rejects.toThrow(
      "outputHelp",
    );

    expect(help).toContain("openclaw artifacts create-pdf brief.json --out brief.pdf");
    expect(help).toContain("openclaw artifacts create-docx brief.json --out brief.docx");
    expect(help).toContain("openclaw artifacts create-xlsx workbook.json --out workbook.xlsx");
    expect(help).toContain("openclaw artifacts create-pptx deck.json --out deck.pptx");
    expect(help).toContain("openclaw artifacts render-pdf brief.pdf --out-dir rendered");
  });

  it("forwards editable Word and Excel creation", async () => {
    const program = new Command();
    registerArtifactsCli(program);
    await program.parseAsync(["artifacts", "create-docx", "brief.json", "--out", "brief.docx"], {
      from: "user",
    });
    await program.parseAsync(["artifacts", "create-xlsx", "book.json", "--out", "book.xlsx"], {
      from: "user",
    });
    expect(artifactsCreateDocxCommand).toHaveBeenCalledWith(
      "brief.json",
      expect.objectContaining({ out: "brief.docx" }),
      expect.any(Object),
    );
    expect(artifactsCreateXlsxCommand).toHaveBeenCalledWith(
      "book.json",
      expect.objectContaining({ out: "book.xlsx" }),
      expect.any(Object),
    );
  });

  it("forwards structured PDF creation", async () => {
    const program = new Command();
    registerArtifactsCli(program);

    await program.parseAsync(["artifacts", "create-pdf", "brief.json", "--out", "brief.pdf"], {
      from: "user",
    });

    expect(artifactsCreatePdfCommand).toHaveBeenCalledWith(
      "brief.json",
      expect.objectContaining({ out: "brief.pdf" }),
      expect.any(Object),
    );
  });

  it("forwards editable PPTX creation", async () => {
    const program = new Command();
    registerArtifactsCli(program);

    await program.parseAsync(["artifacts", "create-pptx", "deck.json", "--out", "deck.pptx"], {
      from: "user",
    });

    expect(artifactsCreatePptxCommand).toHaveBeenCalledWith(
      "deck.json",
      expect.objectContaining({ out: "deck.pptx" }),
      expect.any(Object),
    );
  });

  it("forwards explicit HTML-to-PDF scale", async () => {
    const program = new Command();
    registerArtifactsCli(program);

    await program.parseAsync(
      ["artifacts", "html-to-pdf", "brief.html", "--out", "brief.pdf", "--scale", "0.95"],
      { from: "user" },
    );

    expect(artifactsHtmlToPdfCommand).toHaveBeenCalledWith(
      "brief.html",
      expect.objectContaining({ out: "brief.pdf", scale: "0.95" }),
      expect.any(Object),
    );
  });

  it("registers document, presentation export, and render commands", async () => {
    const program = new Command();
    registerArtifactsCli(program);

    await program.parseAsync(["artifacts", "docx-to-pdf", "brief.docx", "--out", "brief.pdf"], {
      from: "user",
    });
    await program.parseAsync(["artifacts", "pptx-to-pdf", "deck.pptx", "--out", "deck.pdf"], {
      from: "user",
    });
    await program.parseAsync(["artifacts", "render-pdf", "brief.pdf", "--out-dir", "rendered"], {
      from: "user",
    });

    expect(artifactsDocxToPdfCommand).toHaveBeenCalledWith(
      "brief.docx",
      expect.objectContaining({ out: "brief.pdf" }),
      expect.any(Object),
    );
    expect(artifactsPptxToPdfCommand).toHaveBeenCalledWith(
      "deck.pptx",
      expect.objectContaining({ out: "deck.pdf" }),
      expect.any(Object),
    );
    expect(artifactsRenderPdfCommand).toHaveBeenCalledWith(
      "brief.pdf",
      expect.objectContaining({ outDir: "rendered" }),
      expect.any(Object),
    );
  });
});
