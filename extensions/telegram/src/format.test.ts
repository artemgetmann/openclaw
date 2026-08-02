import { describe, expect, it } from "vitest";
import {
  markdownToTelegramHtml,
  markdownToTelegramRichHtml,
  rewriteMarkdownBlockquotesAsCopyBlocks,
  splitTelegramHtmlChunks,
  splitTelegramRichMessageTextChunks,
} from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("handles core markdown-to-telegram conversions", () => {
    const cases = [
      [
        "renders basic inline formatting",
        "hi _there_ **boss** `code`",
        "hi <i>there</i> <b>boss</b> <code>code</code>",
      ],
      [
        "renders links as Telegram-safe HTML",
        "see [docs](https://example.com)",
        'see <a href="https://example.com">docs</a>',
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["escapes unsafe characters", "a & b < c", "a &amp; b &lt; c"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders lists without block HTML", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["flattens headings", "# Title", "Title"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToTelegramHtml(input), name).toBe(expected);
    }
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("can render blockquoted draft text as copyable code blocks", () => {
    const res = markdownToTelegramHtml(
      [
        "I would send:",
        "",
        "> Hi Sveta, here is the page: [booking](https://example.com/booking).",
        "> Please confirm the passenger names.",
      ].join("\n"),
      { copySafeBlockquotes: true },
    );

    expect(res).toContain("I would send:");
    expect(res).toContain("<pre><code>");
    expect(res).toContain("Hi Sveta, here is the page: booking (https://example.com/booking).");
    expect(res).toContain("Please confirm the passenger names.");
    expect(res).not.toContain("<blockquote>");
    expect(res).not.toContain("<a href");
  });

  it("keeps a multi-paragraph recipient draft in one tap-to-copy block", () => {
    const res = markdownToTelegramHtml(
      [
        "Ready to send (Italian)",
        "",
        "> Raffaele, voglio separare chiaramente due argomenti.",
        ">",
        "> Il primo riguarda il Suo utilizzo personale di Jarvis.",
        ">",
        "> Poi può scegliere un orario qui:",
        "> https://calendar.app.google/example",
      ].join("\n"),
      { copySafeBlockquotes: true },
    );

    expect(res.match(/<pre><code>/g)).toHaveLength(1);
    expect(res).toContain(
      [
        "Raffaele, voglio separare chiaramente due argomenti.",
        "",
        "Il primo riguarda il Suo utilizzo personale di Jarvis.",
        "",
        "Poi può scegliere un orario qui:",
        "https://calendar.app.google/example",
      ].join("\n"),
    );
  });

  it("can render rich-message draft blockquotes as copyable code blocks", () => {
    const res = markdownToTelegramRichHtml(
      [
        "Suggested reply:",
        "",
        "> Hi Sveta, here is the page: [booking](https://example.com/booking).",
        "> Please confirm the passenger names.",
      ].join("\n"),
      { copySafeBlockquotes: true },
    );

    expect(res).toContain("<p>Suggested reply:</p>");
    expect(res).toContain("<pre><code>");
    expect(res).toContain("Hi Sveta, here is the page: booking (https://example.com/booking).");
    expect(res).toContain("Please confirm the passenger names.");
    expect(res).not.toContain("<blockquote>");
    expect(res).not.toContain("<a href");
  });

  it("rewrites only Markdown blockquotes when preparing copy-safe draft blocks", () => {
    const res = rewriteMarkdownBlockquotesAsCopyBlocks(
      "Normal **bold**.\n\n> Draft [link](https://e.com)",
    );

    expect(res).toContain("Normal **bold**.");
    expect(res).toContain("```\nDraft link (https://e.com)\n```");
  });

  it("does not rewrite quote-prefixed lines inside fenced code", () => {
    const markdown = [
      "```text",
      "> ~~~",
      "```not-a-close",
      "> keep this literal",
      "```",
      "",
      "> Hi Sveta, please confirm.",
    ].join("\n");

    const res = rewriteMarkdownBlockquotesAsCopyBlocks(markdown);

    expect(res).toContain("```text\n> ~~~\n```not-a-close\n> keep this literal\n```");
    expect(res).toContain("```\nHi Sveta, please confirm.\n```");
  });

  it("keeps fenced Markdown tables inside copy-safe drafts", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Plan | Owner |",
        "| --- | --- |",
        "| Ship | Jarvis |",
        "",
        "> Paste this Markdown:",
        "> ```",
        "> | A | B |",
        "> | --- | --- |",
        "> | x | y |",
        "> ```",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| A | B |");
    expect(richHtml).toContain("| x | y |");
  });

  it("keeps indented Markdown tables inside literal code blocks", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Plan | Owner |",
        "| --- | --- |",
        "| Ship | Jarvis |",
        "",
        "    ```",
        "    | A | B |",
        "    | --- | --- |",
        "    | x | y |",
        "    ```",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| A | B |");
    expect(richHtml).toContain("| x | y |");
  });

  it("does not absorb indented delimiters or rows into native tables", () => {
    const indentedDelimiterHtml = markdownToTelegramRichHtml(
      ["| Literal header | Literal owner |", "    | --- | --- |"].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );
    const indentedRowHtml = markdownToTelegramRichHtml(
      ["| Second | Table |", "| --- | --- |", "    | literal | indented row |"].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    // CommonMark indented code stays literal even when it resembles a table
    // delimiter or data row next to an otherwise valid table candidate.
    expect(indentedDelimiterHtml).not.toContain("<table bordered striped>");
    expect(indentedDelimiterHtml).toContain("| Literal header | Literal owner |");
    expect(indentedDelimiterHtml).toContain("| --- | --- |");
    expect(indentedRowHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(indentedRowHtml).toContain("<pre><code>| literal | indented row |");
    expect(indentedRowHtml).not.toContain("<td>literal</td>");
  });

  it("keeps list-nested fenced tables literal beside native tables", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "- ```md",
        "  | A | B |",
        "  | --- | --- |",
        "  | x | y |",
        "  ```",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| A | B |");
    expect(richHtml).toContain("| x | y |");
  });

  it("ends an unclosed list fence when its container deindents", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "- ```md",
        "  | literal | code |",
        "  | --- | --- |",
        "",
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "> Send this draft.",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(2);
    expect(richHtml).toContain("| literal | code |");
    expect(richHtml).toContain("Send this draft.");
    expect(richHtml).not.toContain("<blockquote>");
  });

  it("reopens a deindented top-level fence after a list fence", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "- ```md",
        "  literal list code",
        "```",
        "| fenced | code |",
        "| --- | --- |",
        "```",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(2);
    expect(richHtml).toContain("| fenced | code |");
    expect(richHtml).not.toContain("<th>fenced</th>");
  });

  it("preserves tab overshoot inside a list-contained fence", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "- ```md",
        "\t  ```",
        "  | fenced | code |",
        "  | --- | --- |",
        "  > keep literal",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| fenced | code |");
    expect(richHtml).toContain("&gt; keep literal");
    expect(richHtml).not.toContain("<th>fenced</th>");
  });

  it("keeps four-space list-continuation fences literal", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "- item",
        "    ```md",
        "  | fenced | code |",
        "  | --- | --- |",
        "    ```",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| fenced | code |");
    expect(richHtml).not.toContain("<th>fenced</th>");
  });

  it("ends unclosed list-continuation fences at container deindent", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "- item",
        "  ```md",
        "  | literal | code |",
        "  | --- | --- |",
        "",
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        "> Send this draft.",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(2);
    expect(richHtml).toContain("| literal | code |");
    expect(richHtml).toContain("Send this draft.");
    expect(richHtml).not.toContain("<blockquote>");
  });

  it("keeps space-tab-indented table-like code literal", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "| Real | Table |",
        "| --- | --- |",
        "| yes | now |",
        "",
        " \t| A | B |",
        " \t| --- | --- |",
        " \t| x | y |",
      ].join("\n"),
      { tableMode: "block", copySafeBlockquotes: true },
    );

    expect(richHtml.match(/<table bordered striped>/g)).toHaveLength(1);
    expect(richHtml.match(/<pre><code>/g)).toHaveLength(1);
    expect(richHtml).toContain("| A | B |");
    expect(richHtml).toContain("| x | y |");
  });

  it("renders fenced code blocks", () => {
    const res = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("wraps punctuated file references in code tags", () => {
    const res = markdownToTelegramHtml("See README.md. Also (backup.sh).");
    expect(res).toContain("<code>README.md</code>.");
    expect(res).toContain("(<code>backup.sh</code>).");
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });

  it("does not treat single pipe as spoiler", () => {
    const res = markdownToTelegramHtml("(￣_￣|) face");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("|");
  });

  it("does not treat unpaired || as spoiler", () => {
    const res = markdownToTelegramHtml("before || after");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("||");
  });

  it("keeps valid spoiler pairs when a trailing || is unmatched", () => {
    const res = markdownToTelegramHtml("||secret|| trailing ||");
    expect(res).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(res).toContain("trailing ||");
  });

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it("fails loudly when a leading entity cannot fit inside a chunk", () => {
    expect(() => splitTelegramHtmlChunks(`A&amp;${"B".repeat(20)}`, 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("fails loudly when tag overhead leaves no room for text", () => {
    expect(() => splitTelegramHtmlChunks("<b><i><u>x</u></i></b>", 10)).toThrow(/tag overhead/i);
  });

  it("renders markdown tables as native rich-message table html in block mode", () => {
    const richHtml = markdownToTelegramRichHtml(
      ["Here:", "", "| Name | Score |", "| --- | ---: |", "| Ada | **9** |", "| Bob | 7 |"].join(
        "\n",
      ),
      { tableMode: "block" },
    );

    expect(richHtml).toContain("<p>Here:</p>");
    expect(richHtml).toContain("<table bordered striped>");
    expect(richHtml).not.toContain("<thead>");
    expect(richHtml).not.toContain("<tbody>");
    expect(richHtml).toContain("<tr><th>Name</th><th>Score</th></tr>");
    expect(richHtml).toContain("<td>Ada</td><td><b>9</b></td>");
  });

  it("renders rich-message prose, bullet lists, numbered lists, and blank lines as blocks", () => {
    const richHtml = markdownToTelegramRichHtml(
      [
        "Quick read: go before you get hungry.",
        "",
        "What I used:",
        "- Checked nearby food options",
        "- Compared travel risk with social energy",
        "- Kept the plan simple",
        "",
        "Best plan:",
        "1. Eat light near home.",
        "2. Leave for Ubud with water.",
        "3. Only snack there if needed.",
      ].join("\n"),
      { tableMode: "block" },
    );

    expect(richHtml).toContain("<p>Quick read: go before you get hungry.</p>");
    expect(richHtml).toContain("<p>What I used:</p><ul>");
    expect(richHtml).toContain("<li>Checked nearby food options</li>");
    expect(richHtml).toContain("<p>Best plan:</p><ol>");
    expect(richHtml).toContain("<li>Eat light near home.</li>");
    expect(richHtml).not.toContain("What I used:\n\n•");
  });

  it("keeps a plain-text fallback for rich-message table chunks", () => {
    const [chunk] = splitTelegramRichMessageTextChunks({
      text: "| Name | Score |\n| --- | --- |\n| Ada | 9 |",
      textLimit: 4000,
      textMode: "markdown",
      tableMode: "block",
    });

    expect(chunk?.text).toContain("<table bordered striped>");
    expect(chunk?.plainText).toBe("Name | Score\nAda | 9");
  });

  it("accounts for escaped fenced-code bytes before splitting rich chunks", () => {
    const chunks = splitTelegramRichMessageTextChunks({
      text: [
        "| Plan | Owner |",
        "| --- | --- |",
        "| Ship | Jarvis |",
        "",
        "```text",
        `> ${">".repeat(90)}`,
        "```",
        "",
        "> Hi Sveta, please confirm.",
      ].join("\n"),
      textLimit: 160,
      textMode: "markdown",
      tableMode: "block",
      copySafeBlockquotes: true,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 160)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("&gt;");
  });

  it("keeps list markers readable in rich-message plain-text fallback", () => {
    const [chunk] = splitTelegramRichMessageTextChunks({
      text: "Plan:\n\n- Eat first\n- Bring water\n\nThen:\n\n1. Leave early\n2. Snack only if needed",
      textLimit: 4000,
      textMode: "markdown",
      tableMode: "block",
    });

    expect(chunk?.plainText).toContain("• Eat first\n• Bring water");
    expect(chunk?.plainText).toContain("1. Leave early\n2. Snack only if needed");
  });

  it("does not render fenced code pipes as native rich-message tables", () => {
    const richHtml = markdownToTelegramRichHtml("```\n| not | a table |\n| --- | --- |\n```", {
      tableMode: "block",
    });

    expect(richHtml).not.toContain("<table>");
    expect(richHtml).toContain("<pre><code>");
  });
});
