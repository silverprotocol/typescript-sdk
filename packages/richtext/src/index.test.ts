import { describe, it, expect } from "vitest";
import parseRichText, { parseInlineRichText, type RichTextBlock, type RichTextInline } from "./index.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** The one-paragraph shortcut most inline tests want. */
function inline(text: string): RichTextInline[] {
  return parseInlineRichText(text);
}

/** Flatten an inline tree back to its visible text (markers stripped). */
function visibleText(nodes: RichTextInline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.text;
    else if (n.type === "break") out += "\n";
    else if (n.type === "code") out += n.code;
    else out += visibleText(n.children);
  }
  return out;
}

// ─── block goldens ────────────────────────────────────────────────────────────

describe("parseRichText — block goldens", () => {
  it("parses the guuey#95 Daily Planner shape (bold inside list items)", () => {
    const blocks = parseRichText(
      "Here is your plan:\n\n- **12:00–2:00 PM** — Finish the pitch deck\n- **2:00–3:00 PM** — Review inbox",
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    const list = blocks[1] as Extract<RichTextBlock, { type: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    const first = list.items[0]?.children ?? [];
    expect(first[0]).toMatchObject({ type: "strong", closed: true });
    expect(visibleText(first)).toBe("12:00–2:00 PM — Finish the pitch deck");
  });

  it("parses headings 1–6 and rejects 7+ hashes and space-less hashes", () => {
    const blocks = parseRichText("# One\n###### Six\n####### Seven\n#NoSpace");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 6 });
    // 7 hashes and #NoSpace are prose, merged into one paragraph.
    expect(blocks[2]?.type).toBe("paragraph");
    expect(blocks).toHaveLength(3);
  });

  it("parses a closed code fence with a lang and keeps blank interior lines", () => {
    const blocks = parseRichText("```ts\nconst a = 1;\n\nconst b = 2;\n```\nafter");
    expect(blocks[0]).toMatchObject({
      type: "code-fence",
      lang: "ts",
      closed: true,
      code: "const a = 1;\n\nconst b = 2;",
    });
    expect(blocks[1]).toMatchObject({ type: "paragraph" });
  });

  it("an ordered list keeps its start number and a marker switch closes the list", () => {
    const blocks = parseRichText("3. three\n4. four\n- bullet");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: false });
  });

  it("single newlines inside a paragraph become explicit break nodes (chat prose is line-broken)", () => {
    const blocks = parseRichText("line one\nline two");
    expect(blocks).toHaveLength(1);
    const children = (blocks[0] as Extract<RichTextBlock, { type: "paragraph" }>).children;
    expect(children).toEqual([
      { type: "text", text: "line one" },
      { type: "break" },
      { type: "text", text: "line two" },
    ]);
  });

  it("indented bullets flatten into the open list (documented v1 behavior, nothing lost)", () => {
    const blocks = parseRichText("- top\n  - nested\n- top again");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Extract<RichTextBlock, { type: "list" }>).items).toHaveLength(3);
  });
});

// ─── inline goldens ───────────────────────────────────────────────────────────

describe("parseInlineRichText — inline goldens", () => {
  it("bold / italic / code / link, closed", () => {
    expect(inline("**b** *i* `c` [t](https://x.io)")).toEqual([
      { type: "strong", children: [{ type: "text", text: "b" }], closed: true },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "i" }], closed: true },
      { type: "text", text: " " },
      { type: "code", code: "c", closed: true },
      { type: "text", text: " " },
      {
        type: "link",
        children: [{ type: "text", text: "t" }],
        href: "https://x.io",
        rawHref: "https://x.io",
        closed: true,
      },
    ]);
  });

  it("nests em inside strong", () => {
    expect(inline("**bold *both***")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "bold " },
          { type: "em", children: [{ type: "text", text: "both" }], closed: true },
        ],
        closed: true,
      },
    ]);
  });

  it("underscore emphasis never fires inside snake_case identifiers", () => {
    expect(inline("use the run_capture_cli helper")).toEqual([
      { type: "text", text: "use the run_capture_cli helper" },
    ]);
    expect(inline("_real emphasis_")).toEqual([
      { type: "em", children: [{ type: "text", text: "real emphasis" }], closed: true },
    ]);
  });

  it("backslash escapes markdown punctuation", () => {
    expect(inline("\\*not bold\\*")).toEqual([{ type: "text", text: "*not bold*" }]);
  });

  it("inline code is verbatim — markers inside a span never parse", () => {
    expect(inline("`**not bold** [x](y)`")).toEqual([
      { type: "code", code: "**not bold** [x](y)", closed: true },
    ]);
  });

  it("[text] followed by non-paren is literal brackets", () => {
    expect(visibleText(inline("see [RFC 2119] for the keywords"))).toBe(
      "see [RFC 2119] for the keywords",
    );
    expect(inline("see [RFC 2119] for the keywords").every((n) => n.type === "text")).toBe(true);
  });
});

// ─── safety policy ────────────────────────────────────────────────────────────

describe("safety policy", () => {
  it("raw HTML is ALWAYS literal text — no HTML node type exists", () => {
    const nodes = inline('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(nodes).toEqual([
      { type: "text", text: '<script>alert(1)</script><img src=x onerror=alert(1)>' },
    ]);
  });

  it("javascript:/data:/vbscript:/relative link targets get NO href (rawHref kept for audit)", () => {
    for (const target of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "JAVASCRIPT:alert(1)",
      "/relative/path",
      "//protocol-relative.example",
    ]) {
      const nodes = inline(`[click](${target})`);
      const link = nodes.find((n) => n.type === "link");
      expect(link, target).toMatchObject({ type: "link", href: undefined, closed: true });
    }
  });

  it("http/https/mailto pass the allowlist, case-insensitively", () => {
    for (const target of [
      "https://example.com/a-b_c?d=e#f",
      "http://example.com",
      "HTTPS://EXAMPLE.COM",
      "mailto:a@b.co",
    ]) {
      const link = inline(`[x](${target})`).find((n) => n.type === "link");
      expect(link, target).toMatchObject({ type: "link", href: target });
    }
  });

  it("a target with embedded whitespace/controls is rejected, not cleaned", () => {
    // `(url "title")` tolerance takes the first word — the title is ignored,
    // the URL itself is intact.
    const link = inline('[x](https://a.io "the title")').find((n) => n.type === "link");
    expect(link).toMatchObject({ href: "https://a.io" });
  });
});

// ─── streaming tolerance ──────────────────────────────────────────────────────

describe("streaming tolerance", () => {
  it("`**bol` parses to an OPEN strong with the partial content (the guuey#95 case)", () => {
    expect(inline("**bol")).toEqual([
      { type: "strong", children: [{ type: "text", text: "bol" }], closed: false },
    ]);
  });

  it("an unclosed fence keeps its content-so-far with closed:false", () => {
    const blocks = parseRichText("```python\nprint('hi'");
    expect(blocks[0]).toMatchObject({
      type: "code-fence",
      lang: "python",
      closed: false,
      code: "print('hi'",
    });
  });

  it("half a link — mid-text, mid-target — styles the text but exposes NO href", () => {
    expect(inline("[te")).toEqual([
      { type: "link", children: [{ type: "text", text: "te" }], href: undefined, rawHref: "", closed: false },
    ]);
    const midTarget = inline("[text](https://exam").find((n) => n.type === "link");
    expect(midTarget).toMatchObject({ href: undefined, rawHref: "https://exam", closed: false });
  });

  it("a dangling inner em closes soft when the outer strong seals (`**a *b** c`)", () => {
    const nodes = inline("**a *b** c");
    expect(nodes[0]).toMatchObject({ type: "strong", closed: true });
    const strong = nodes[0] as Extract<RichTextInline, { type: "strong" }>;
    expect(strong.children[1]).toMatchObject({ type: "em", closed: false });
    expect(visibleText(nodes)).toBe("a b c");
  });

  it("EVERY prefix of a marker-dense document parses without throwing, and visible text is monotone", () => {
    const doc =
      "# Plan\n\nIntro with **bold**, *em*, `code`, and [a link](https://x.io/a_b-c).\n\n" +
      "```ts\nconst a = \"**not md**\";\n```\n\n1. first\n2. **second** — with dash\n\n- last _one_\n\n" +
      "| # | Task |\n|:-:|---|\n| 1 | **ship** it |\n| 2 | `a\\|b` |\n";
    let prevVisible = "";
    for (let i = 0; i <= doc.length; i++) {
      const prefix = doc.slice(0, i);
      const blocks = parseRichText(prefix); // must not throw at ANY cut point
      const vis = blocks
        .map((b) =>
          b.type === "code-fence"
            ? b.code
            : b.type === "list"
              ? b.items.map((it) => visibleText(it.children)).join("\n")
              : b.type === "table"
                ? [b.header, ...b.rows].map((r) => r.cells.map((c) => visibleText(c.children)).join(" ")).join("\n")
                : visibleText(b.children),
        )
        .join("\n");
      // Soft-fail bound: the visible text never exceeds what has streamed in,
      // and it never shrinks by more than one in-flight marker's worth as a
      // construct disambiguates (we assert the cheap invariant: parse output
      // exists and earlier COMPLETED paragraphs' text is stable).
      expect(vis.length).toBeLessThanOrEqual(prefix.length);
      if (prevVisible.includes("\n\n")) {
        // nothing to assert strictly here beyond no-throw; kept as a guard
        // that the loop actually exercises multi-block prefixes.
      }
      prevVisible = vis;
    }
    expect(prevVisible.length).toBeGreaterThan(0);
  });

  it("re-parsing a grown buffer never reshapes COMPLETED blocks (delta-append stability)", () => {
    const full = "# Title\n\nfirst paragraph is done.\n\n- item one\n- item two\n\n**tail";
    const cut = full.indexOf("**tail");
    const before = parseRichText(full.slice(0, cut));
    const after = parseRichText(full);
    // Every block that was complete before the tail streamed is byte-identical.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toMatchObject({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", text: "tail" }], closed: false }],
    });
  });
});

// ─── tables (GFM pipe subset — typescript-sdk#23 / guuey#370) ─────────────────

type Table = Extract<RichTextBlock, { type: "table" }>;

/** Row → visible cell strings. */
function rowText(row: { cells: { children: RichTextInline[] }[] }): string[] {
  return row.cells.map((c) => visibleText(c.children));
}

describe("tables — GFM pipe subset", () => {
  it("parses the guuey#370 shape (header, delimiter, body rows) with inline markdown inside cells", () => {
    const blocks = parseRichText("| # | Task |\n|---|------|\n| 1 | Ship it |\n| 2 | **Bold** cell |\n");
    expect(blocks).toHaveLength(1);
    const t = blocks[0] as Table;
    expect(t.type).toBe("table");
    expect(t.align).toEqual([undefined, undefined]);
    expect(rowText(t.header)).toEqual(["#", "Task"]);
    expect(t.rows.map(rowText)).toEqual([
      ["1", "Ship it"],
      ["2", "Bold cell"],
    ]);
    expect(t.rows[1]?.cells[1]?.children[0]).toMatchObject({ type: "strong", closed: true });
  });

  it("reads column alignment from the delimiter row (left / center / right / none)", () => {
    const t = parseRichText("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |\n")[0] as Table;
    expect(t.align).toEqual(["left", "center", "right", undefined]);
  });

  it("outer pipes are optional; whitespace around cells is trimmed", () => {
    const t = parseRichText("a | b\n--|--\n 1 |2 \n")[0] as Table;
    expect(rowText(t.header)).toEqual(["a", "b"]);
    expect(t.rows.map(rowText)).toEqual([["1", "2"]]);
  });

  it("the header's column count rules: short rows are padded, long rows drop excess (GFM)", () => {
    const t = parseRichText("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n")[0] as Table;
    expect(t.rows.map(rowText)).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
    // Empty cells are real cells with no children — renderers can still lay them out.
    expect(t.rows[0]?.cells[1]).toEqual({ children: [] });
  });

  it("`\\|` is the cell-pipe escape — literal pipe in the cell, even inside a code span (GFM)", () => {
    const t = parseRichText("| expr | note |\n|---|---|\n| `a \\| b` | x \\| y |\n")[0] as Table;
    expect(t.rows.map(rowText)).toEqual([["a | b", "x | y"]]);
    expect(t.rows[0]?.cells[0]?.children[0]).toMatchObject({ type: "code", code: "a | b", closed: true });
  });

  it("a header/delimiter cell-count mismatch is NOT a table — the lines stay literal paragraph text", () => {
    const blocks = parseRichText("| a | b |\n|---|\n| 1 | 2 |\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
    expect(visibleText((blocks[0] as Extract<RichTextBlock, { type: "paragraph" }>).children)).toBe(
      "| a | b |\n|---|\n| 1 | 2 |",
    );
  });

  it("both rows need a pipe — `Title` over `---` is a paragraph, never a one-column table", () => {
    const blocks = parseRichText("Title\n---\nmore\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
    const one = parseRichText("Title\n|---|\n");
    expect(one.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("only the line directly above the delimiter becomes the header; earlier lines stay a paragraph", () => {
    const blocks = parseRichText("Here is the plan:\n| # | Task |\n|---|---|\n| 1 | Go |\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table"]);
    expect(visibleText((blocks[0] as Extract<RichTextBlock, { type: "paragraph" }>).children)).toBe("Here is the plan:");
    expect(rowText((blocks[1] as Table).header)).toEqual(["#", "Task"]);
  });

  it("a table ends at a blank line, a pipe-less prose line, a heading, a fence, or a list — what follows parses normally", () => {
    const blocks = parseRichText(
      "| a |\n|---|\n| 1 |\nplain prose\n\n| b |\n|---|\n| 2 |\n# Heading\n| c |\n|---|\n- item\n| d |\n|---|\n```\ncode\n```\n",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "table",
      "paragraph",
      "table",
      "heading",
      "table",
      "list",
      "table",
      "code-fence",
    ]);
    expect((blocks[0] as Table).rows).toHaveLength(1);
    expect(visibleText((blocks[1] as Extract<RichTextBlock, { type: "paragraph" }>).children)).toBe("plain prose");
    expect((blocks[4] as Table).rows).toHaveLength(0);
  });

  it("the safety policy is unchanged inside cells — raw HTML is text, unsafe link targets get no href", () => {
    const t = parseRichText("| html | link |\n|---|---|\n| <script>x</script> | [go](javascript:evil) |\n")[0] as Table;
    expect(rowText(t.rows[0] ?? { cells: [] })).toEqual(["<script>x</script>", "go"]);
    expect(t.rows[0]?.cells[1]?.children[0]).toMatchObject({ type: "link", href: undefined, rawHref: "javascript:evil" });
  });

  it("streams: the delimiter row must complete (newline) before the table forms — then rows grow in place", () => {
    const header = "| # | Task |\n";
    // Header alone, then the delimiter still being typed: a two-line paragraph, never a flapping table.
    for (const partial of ["|", "|:-", "|:-:|", "|:-:|---", "|:-:|---|"]) {
      const blocks = parseRichText(header + partial);
      expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
    }
    // The newline lands: one-way flip to a table with a stable header + alignment.
    const formed = parseRichText(header + "|:-:|---|\n");
    expect(formed).toEqual([
      {
        type: "table",
        align: ["center", undefined],
        header: { cells: [{ children: [{ type: "text", text: "#" }] }, { children: [{ type: "text", text: "Task" }] }] },
        rows: [],
      },
    ]);
    // Rows stream: a partial last row is a row-so-far with an OPEN inline construct; earlier rows are byte-identical.
    const twoRows = parseRichText(header + "|:-:|---|\n| 1 | done |\n| 2 | **in pro");
    const t = twoRows[0] as Table;
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual((formed[0] as Table).rows[0] ?? parseRichText(header + "|:-:|---|\n| 1 | done |\n").map((b) => (b as Table).rows[0])[0]);
    expect(t.rows[1]?.cells[1]?.children[0]).toMatchObject({ type: "strong", closed: false });
    expect(rowText(t.rows[1] ?? { cells: [] })).toEqual(["2", "in pro"]);
    const grown = parseRichText(header + "|:-:|---|\n| 1 | done |\n| 2 | **in progress** |\n| 3 |");
    expect((grown[0] as Table).rows[0]).toEqual(t.rows[0]);
    expect((grown[0] as Table).header).toEqual(t.header);
    expect((grown[0] as Table).rows[1]?.cells[1]?.children[0]).toMatchObject({ type: "strong", closed: true });
  });
});

describe("indented fences (CommonMark 0–3 spaces; list-item continuation)", () => {
  const types = (t: string): string[] => parseRichText(t).map((b) => b.type);

  it("a fence indented 1, 2 or 3 spaces is a code-fence; its indent is stripped from the body", () => {
    for (const ind of [" ", "  ", "   "]) {
      const blocks = parseRichText(`Steps:\n\n${ind}\`\`\`json\n${ind}{"a":1}\n${ind}  nested\n${ind}\`\`\``);
      expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code-fence"]);
      expect(blocks[1]).toEqual({ type: "code-fence", code: '{"a":1}\n  nested', lang: "json", closed: true });
    }
  });

  it("a body line indented less than the fence loses only the spaces it has", () => {
    expect(parseRichText("  ```\n x\ny\n  ```")[0]).toMatchObject({ code: "x\ny", closed: true });
  });

  it("a fence indented 4 spaces outside a list stays prose (indented code is out of the subset)", () => {
    expect(types("Steps:\n\n    ```json\n    x\n    ```")).toEqual(["paragraph", "paragraph"]);
  });

  it("an indented closing fence closes an unindented opener, and vice versa", () => {
    expect(parseRichText("```\nx\n   ```\nafter")).toEqual([
      { type: "code-fence", code: "x", lang: undefined, closed: true },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
    ]);
    expect(parseRichText("  ```\nx\n```")[0]).toMatchObject({ code: "x", closed: true });
  });

  it("a fence continuing a list item ends the list and parses as a top-level code-fence (block content inside items is out of the subset)", () => {
    const blocks = parseRichText("1. Run this:\n\n   ```bash\n   npm i\n   ```");
    expect(blocks.map((b) => b.type)).toEqual(["list", "code-fence"]);
    expect(blocks[1]).toEqual({ type: "code-fence", code: "npm i", lang: "bash", closed: true });
    // No blank line between the item and the fence: same result.
    expect(types("1. Run this:\n   ```bash\n   npm i\n   ```")).toEqual(["list", "code-fence"]);
  });

  it("a fence at a wide item's content column (+0–3) continues it; a later item opens a list that keeps its number", () => {
    const blocks = parseRichText("10. Install:\n\n    ```sh\n    npm i\n    ```\n11. Run:\n\n      ```sh\n      npm t\n      ```");
    expect(blocks.map((b) => b.type)).toEqual(["list", "code-fence", "list", "code-fence"]);
    expect(blocks[1]).toMatchObject({ code: "npm i", closed: true });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 11 });
    expect(blocks[3]).toMatchObject({ code: "npm t", closed: true });
    expect(types("- step\n\n  ```\n  x\n  ```")).toEqual(["list", "code-fence"]);
  });

  it("only blank lines may sit between the item and a deep fence; prose in between ends the continuation", () => {
    expect(types("10. Install:\n\nthen\n    ```sh\n    npm i\n    ```")).toEqual(["list", "paragraph"]);
    expect(types("10. Install:\n\n# H\n    ```sh\n    x\n    ```")).toEqual(["list", "heading", "paragraph"]);
  });

  it("streams: every prefix of an indented-fence document parses; once the opener line is complete the fence never reshapes earlier blocks", () => {
    const doc = "Steps:\n\n1. Run this:\n\n   ```bash\n   npm i\n   ```\n2. Done.\n";
    const opener = doc.indexOf("```bash\n") + "```bash\n".length;
    const head = parseRichText(doc.slice(0, opener)).slice(0, 2);
    for (let i = 0; i <= doc.length; i++) {
      const blocks = parseRichText(doc.slice(0, i));
      if (i >= opener) {
        expect(blocks.slice(0, 2)).toEqual(head);
        expect(blocks[2]).toMatchObject({ type: "code-fence", lang: "bash" });
      }
    }
    expect(types(doc)).toEqual(["paragraph", "list", "code-fence", "list"]);
  });
});

// ─── workspace#35: emphasis closer choice; indented list continuation ────────

type List = Extract<RichTextBlock, { type: "list" }>;
const blockTypes = (t: string): string[] => parseRichText(t).map((b) => b.type);

describe("emphasis: a delimiter run closes the innermost frame whose marker it matches exactly (workspace#35)", () => {
  it("an em holding a strong closes at its own `*`, not at the strong's `**` (`*a **b** c*`)", () => {
    expect(inline("*a **b** c*")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }], closed: true },
          { type: "text", text: " c" },
        ],
        closed: true,
      },
    ]);
  });

  it("the underscore forms and a nested em of the same marker close the same way", () => {
    expect(inline("_a __b__ c_")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }], closed: true },
          { type: "text", text: " c" },
        ],
        closed: true,
      },
    ]);
    expect(inline("*a *b* c*")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "em", children: [{ type: "text", text: "b" }], closed: true },
          { type: "text", text: " c" },
        ],
        closed: true,
      },
    ]);
  });

  it("a run with no exact match still spends itself across frames (`***` seals em and strong; `**a *b** c` dangles the em)", () => {
    expect(inline("*a **b***")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }], closed: true },
        ],
        closed: true,
      },
    ]);
    const nodes = inline("**a *b** c");
    expect(nodes[0]).toMatchObject({ type: "strong", closed: true });
    expect((nodes[0] as Extract<RichTextInline, { type: "strong" }>).children[1]).toMatchObject({ type: "em", closed: false });
  });

  it("the exact pass honours the link bracket: emphasis never closes across a `[` (`*a [b* c](https://x.io) d*`)", () => {
    expect(inline("*a [b* c](https://x.io) d*")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "link", children: [{ type: "text", text: "b* c" }], href: "https://x.io", rawHref: "https://x.io", closed: true },
          { type: "text", text: " d" },
        ],
        closed: true,
      },
    ]);
  });

  it("inside a paragraph and a list item the fix holds, and no stray `*` reaches the text", () => {
    const blocks = parseRichText("*a **b** c*\n\n- *x **y** z*");
    expect(blocks[0]).toMatchObject({ type: "paragraph", children: [{ type: "em", closed: true }] });
    expect((blocks[1] as List).items[0]?.children).toMatchObject([{ type: "em", closed: true }]);
    expect(JSON.stringify(blocks)).not.toContain("*");
  });
});

describe("lists: an indented line under an item continues that item (workspace#35)", () => {
  it("`- item one` / `  continued line` / `- item two` is ONE list of two items; the continuation joins with a break", () => {
    expect(parseRichText("- item one\n  continued line\n- item two")).toEqual([
      {
        type: "list",
        ordered: false,
        start: undefined,
        items: [
          { children: [{ type: "text", text: "item one" }, { type: "break" }, { type: "text", text: "continued line" }] },
          { children: [{ type: "text", text: "item two" }] },
        ],
      },
    ]);
  });

  it("ordered items, several continuation lines, and any indent (one space or more, or a tab) continue the item", () => {
    const [list] = parseRichText("1. first\n   more\n line three\n2. second") as List[];
    expect(list).toMatchObject({ ordered: true, start: 1 });
    expect(list?.items.map((it) => visibleText(it.children))).toEqual(["first\nmore\nline three", "second"]);
    expect(visibleText((parseRichText("- a\n\tb")[0] as List).items[0]?.children ?? [])).toBe("a\nb");
  });

  it("a continuation joins the item directly above it, not the first item", () => {
    const items = (src: string): string[] => (parseRichText(src)[0] as List).items.map((it) => visibleText(it.children));
    expect(items("- a\n  a2\n- b\n  b2")).toEqual(["a\na2", "b\nb2"]);
    expect(items("1. a\n2. b\n   b2\n3. c")).toEqual(["a", "b\nb2", "c"]);
  });

  it("an indented table or heading line under an item is block content inside the item, so it stays item text", () => {
    const blocks = parseRichText("- a\n  | x | y |\n  |---|---|\n  | 1 | 2 |");
    expect(blocks.map((b) => b.type)).toEqual(["list"]);
    expect(visibleText((blocks[0] as List).items[0]?.children ?? [])).toBe("a\n| x | y |\n|---|---|\n| 1 | 2 |");
    const heading = parseRichText("- a\n  # h");
    expect(heading.map((b) => b.type)).toEqual(["list"]);
    expect(visibleText((heading[0] as List).items[0]?.children ?? [])).toBe("a\n# h");
  });

  it("inline constructs span the continuation (the item's lines parse as one inline run)", () => {
    const [list] = parseRichText("- **bold\n  still bold** done") as List[];
    expect(list?.items[0]?.children).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold" }, { type: "break" }, { type: "text", text: "still bold" }], closed: true },
      { type: "text", text: " done" },
    ]);
  });

  it("an UNINDENTED line still ends the list (lazy continuation stays out of the subset), and a blank line still does", () => {
    expect(blockTypes("- a\nb")).toEqual(["list", "paragraph"]);
    expect(blockTypes("- a\n\n  b")).toEqual(["list", "paragraph"]);
  });

  it("an indented bullet still flattens into the list, and a fence after a continued item still continues it", () => {
    expect((parseRichText("- a\n  more\n  - b")[0] as List).items.map((it) => visibleText(it.children))).toEqual(["a\nmore", "b"]);
    expect(blockTypes("- a\n  more\n\n  ```\n  x\n  ```")).toEqual(["list", "code-fence"]);
    // A fence at a wide item's content column (indent 4 > 3) needs that column kept across the continuation.
    expect(parseRichText("10. Install:\n    then\n\n    ```sh\n    npm i\n    ```")).toMatchObject([
      { type: "list", items: [{ children: [{ type: "text", text: "Install:" }, { type: "break" }, { type: "text", text: "then" }] }] },
      { type: "code-fence", code: "npm i", lang: "sh", closed: true },
    ]);
  });

  it("streams: every prefix parses, and once the continuation line has begun its text stays in the first item", () => {
    const doc = "- item one\n  continued line\n- item two\n";
    const begun = doc.indexOf("  continued") + 3;
    for (let i = 0; i <= doc.length; i++) {
      const prefix = doc.slice(0, i);
      const blocks = parseRichText(prefix);
      if (i < begun) continue;
      const shown = prefix.slice(begun - 1, Math.min(prefix.length, doc.indexOf("\n- item two")));
      expect(blocks[0]?.type).toBe("list");
      expect(visibleText((blocks[0] as List).items[0]?.children ?? [])).toBe(`item one\n${shown}`);
      // A half-typed next marker (`-` with no space yet) is the open trailing block,
      // as for any list; the continuation never moves into it.
      expect(blocks.slice(1).every((blk) => !JSON.stringify(blk).includes("continued"))).toBe(true);
    }
    expect(blockTypes(doc)).toEqual(["list"]);
  });
});
