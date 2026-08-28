# @silverprotocol/richtext

The headless rich-text block model for AgJSON `text` content. Agents emit
markdown in chat (`**bold**`, lists, headings); this package turns that text
into a **typed AST** and owns the **safety policy** — once, for every host —
while rendering stays entirely yours.

- **Headless.** No components, no styling, no dependencies. You map the AST
  onto your own renderers and design tokens (React, React Native, DOM,
  terminal — anything).
- **Safe by construction.** Raw HTML is never interpreted: no HTML node type
  exists, so `<script>` in model output can only ever be literal text. Link
  `href` is populated only for `http:` / `https:` / `mailto:` targets —
  everything else (`javascript:`, `data:`, relative paths) parses as a link
  with `href: undefined`.
- **Streaming-tolerant.** Feed a growing buffer on every `text.delta` and
  re-parse: mid-stream input with unclosed markers (`**bol`, a dangling code
  fence, half a link) parses to a stable AST with `closed: false` on the open
  construct. Completed constructs never change shape.

## Install

```sh
npm install @silverprotocol/richtext
```

## Usage

```ts
import { parseRichText } from "@silverprotocol/richtext";

const blocks = parseRichText("- **12:00–2:00 PM** — Finish the pitch deck");
// [{ type: "list", ordered: false, items: [{ children: [
//    { type: "strong", children: [{ type: "text", text: "12:00–2:00 PM" }], closed: true },
//    { type: "text", text: " — Finish the pitch deck" },
// ] }] }]
```

Walk the `RichTextBlock[]` and map each node to your renderer. The one
rendering rule: every string in the AST (`text`, `code`) is **literal
content** — render it as text content (React children / RN `<Text>` /
`textContent`), never as markup.

### The subset

Blocks: paragraphs (single newlines become explicit `break` nodes — chat prose
is line-broken), headings (`#`–`######`), fenced code (with language tag),
flat ordered/unordered lists, pipe tables (GFM subset). Inline: `**strong**`,
`*em*` / `_em_`, `` `code` ``, `[links](https://…)`, backslash escapes.

Deliberately out of v1 (parses as plain text): images, blockquotes,
strikethrough, autolinked bare URLs, nested lists, table cell spans, raw HTML
(permanently).

### Tables

The GFM pipe-table subset — a header row, a delimiter row, body rows:

```ts
parseRichText("| # | Task |\n|:-:|------|\n| 1 | **Ship** it |");
// [{ type: "table",
//    align: ["center", undefined],          // per column, from the delimiter row
//    header: { cells: [{ children: [{ type: "text", text: "#" }] }, …] },
//    rows: [{ cells: [{ children: [{ type: "text", text: "1" }] },
//                     { children: [{ type: "strong", … }, { type: "text", text: " it" }] }] }] }]
```

The header fixes the column count: every row has exactly `align.length`
cells (short rows are padded with empty cells, long rows drop the excess —
GFM's rule). Outer pipes are optional, `\|` is the cell-pipe escape (it works
inside code spans), and cells hold inline content only. A table ends at a
blank line, another block, or any line without a pipe. While streaming, the
delimiter row has to complete (a newline follows it) before the table forms —
until then the header and the half-typed delimiter are an ordinary two-line
paragraph, so a renderer never sees a table flap back into prose.

### Streaming

```ts
parseRichText("**bol");
// [{ type: "paragraph", children: [
//    { type: "strong", children: [{ type: "text", text: "bol" }], closed: false },
// ] }]
```

`closed: false` is the signal — style it optimistically or plainly, your call;
when the closing marker arrives, the same node completes in place.

Spec: [silverprotocol.io/AgJSON](https://silverprotocol.io/AgJSON) — proposed
in [workspace#8]; the AST is protocol-adjacent (it defines what a `text`
block's content means to a renderer), presentation is host business.
