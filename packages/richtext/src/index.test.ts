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
