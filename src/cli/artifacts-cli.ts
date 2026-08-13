import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runArtifactsCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerArtifactsCli(program: Command) {
  const artifacts = program
    .command("artifacts")
    .description("Create and verify document artifacts")
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n${formatHelpExamples([
          ["openclaw artifacts status --json", "Show resolved artifact runtime dependencies."],
          [
            "openclaw artifacts create-docx brief.json --out brief.docx",
            "Create an editable Word document from a structured JSON spec.",
          ],
          [
            "openclaw artifacts create-xlsx workbook.json --out workbook.xlsx",
            "Create an editable Excel workbook from a structured JSON spec.",
          ],
          [
            "openclaw artifacts create-pdf brief.json --out brief.pdf",
            "Create a simple structured PDF without browser or LaTeX conversion.",
          ],
          [
            "openclaw artifacts html-to-pdf brief.html --out brief.pdf --scale 1",
            "Render HTML to PDF with explicit print scale.",
          ],
          [
            "openclaw artifacts docx-to-pdf brief.docx --out brief.pdf",
            "Export a DOCX to PDF with LibreOffice.",
          ],
          [
            "openclaw artifacts create-pptx deck.json --out deck.pptx",
            "Create an editable PPTX deck from a structured JSON spec.",
          ],
          [
            "openclaw artifacts pptx-to-pdf deck.pptx --out deck.pdf",
            "Export a PPTX deck to PDF with LibreOffice.",
          ],
          [
            "openclaw artifacts render-pdf brief.pdf --out-dir rendered",
            "Render PDF pages to PNGs for visual QA.",
          ],
        ])}\n`,
    )
    .action(() => {
      artifacts.help({ error: true });
    });

  artifacts
    .command("create-docx")
    .description("Create an editable DOCX document from a JSON spec")
    .argument("<input>", "JSON spec with title, sections, paragraphs, bullets, and tables")
    .option("--out <path>", "Output DOCX path")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsCreateDocxCommand } = await import("../commands/artifacts.js");
        await artifactsCreateDocxCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("create-xlsx")
    .description("Create an editable XLSX workbook from a JSON spec")
    .argument("<input>", "JSON spec with sheets, rows, widths, and frozen panes")
    .option("--out <path>", "Output XLSX path")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsCreateXlsxCommand } = await import("../commands/artifacts.js");
        await artifactsCreateXlsxCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("create-pdf")
    .description("Create a simple structured PDF from a JSON spec")
    .argument(
      "<input>",
      "JSON spec with title, sections, paragraphs, bullets, callouts, and tables",
    )
    .option("--out <path>", "Output PDF path")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsCreatePdfCommand } = await import("../commands/artifacts.js");
        await artifactsCreatePdfCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("create-pptx")
    .description("Create an editable PPTX deck from a JSON spec")
    .argument("<input>", "JSON spec with title, subtitle, and slides")
    .option("--out <path>", "Output PPTX path")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsCreatePptxCommand } = await import("../commands/artifacts.js");
        await artifactsCreatePptxCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("status")
    .description("Show resolved artifact runtime dependencies")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsStatusCommand } = await import("../commands/artifacts.js");
        await artifactsStatusCommand(opts, defaultRuntime);
      });
    });

  artifacts
    .command("html-to-pdf")
    .description("Render an HTML file or URL to PDF")
    .argument("<input>", "HTML file path, file:// URL, or http(s) URL")
    .option("--out <path>", "Output PDF path")
    .option("--scale <n>", "Print scale from 0.1 to 2 (default: 1)", "1")
    .option("--format <name>", "Paper format (default: Letter)", "Letter")
    .option("--prefer-css-page-size", "Let CSS @page size override format", false)
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsHtmlToPdfCommand } = await import("../commands/artifacts.js");
        await artifactsHtmlToPdfCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("docx-to-pdf")
    .description("Export a DOCX file to PDF with LibreOffice")
    .argument("<input>", "DOCX file path")
    .option("--out <path>", "Output PDF path")
    .option("--out-dir <dir>", "Output directory used for conversion")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsDocxToPdfCommand } = await import("../commands/artifacts.js");
        await artifactsDocxToPdfCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("pptx-to-pdf")
    .description("Export a PPTX deck to PDF with LibreOffice")
    .argument("<input>", "PPTX file path")
    .option("--out <path>", "Output PDF path")
    .option("--out-dir <dir>", "Output directory used for conversion")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsPptxToPdfCommand } = await import("../commands/artifacts.js");
        await artifactsPptxToPdfCommand(input, opts, defaultRuntime);
      });
    });

  artifacts
    .command("render-pdf")
    .description("Render PDF pages to PNG files for visual QA")
    .argument("<input>", "PDF file path")
    .option("--out-dir <dir>", "Output directory for PNG pages")
    .option("--prefix <name>", "Output PNG filename prefix")
    .option("--json", "Output JSON", false)
    .action(async (input: string, opts) => {
      await runArtifactsCommand(async () => {
        const { artifactsRenderPdfCommand } = await import("../commands/artifacts.js");
        await artifactsRenderPdfCommand(input, opts, defaultRuntime);
      });
    });
}
