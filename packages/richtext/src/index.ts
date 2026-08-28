/**
 * `@silverprotocol/richtext` — the headless rich-text block model for AgJSON
 * `text` content (workspace#8).
 *
 * Agents emit markdown in chat text (`**bold**`, lists, headings); every host
 * that renders an AgJSON stream needs the SAME answer to "what does this text
 * MEAN to a renderer". This package owns exactly that seam and nothing more:
 *
 *  - `parseRichText(text)` → a typed block/inline AST for the CONVERSATIONAL
 *    markdown subset: bold / italic / inline code / fenced code / lists /
 *    headings / links / pipe tables (plus explicit line breaks — chat prose
 *    is line-broken and a renderer that joins lines destroys it).
 *  - The SAFETY POLICY lives here, once. Raw HTML is NEVER interpreted — no
 *    HTML node type exists in the AST, so `<script>` in model output can only
 *    ever be literal text. Link `href` is populated ONLY for http/https/mailto
 *    targets; everything else (javascript:, data:, vbscript:, relative paths)
 *    parses as a link whose `href` is `undefined` — hosts get the styled text
 *    but nothing navigable. Rich HTML has its own channel (tool-result UI
 *    resources); chat text is untrusted model output.
 *  - STREAMING-TOLERANT by design: mid-stream input with unclosed markers
 *    (`**bol`, a dangling fence, half a link) parses to a stable AST that
 *    fails SOFT — the construct exists with `closed: false` and its partial
 *    content, never a throw, never a reshuffle of earlier siblings. Feed a
 *    growing buffer on every `text.delta` and re-parse: completed constructs
 *    never change shape; only the trailing OPEN construct extends (or
 *    disambiguates) as input arrives.
 *
 * NO components, NO styling, NO dependencies — hosts map the AST onto their
 * own renderers and design systems. Rendering rule for hosts: every string in
 * this AST (`text`, `code`) is literal content — render it as text content
 * (React children / RN <Text> / textContent), NEVER as markup.
 *
 * TABLES (typescript-sdk#23, downstream guuey#370) are the GFM pipe-table
 * subset: a header row, a delimiter row (`|---|:---:|---:|` — the alignment
 * source), then body rows; no cell spans, no block content inside cells.
 * The rules follow GFM where GFM has one and stay predictable for chat where
 * it doesn't:
 *  - a table is recognized when a delimiter row whose cell count equals the
 *    PRECEDING line's cell count arrives — that line becomes the header, any
 *    earlier lines of the same paragraph stay a paragraph (GFM);
 *  - both rows need at least one unescaped `|` — `Title\n---` never becomes
 *    a one-column table (and setext headings stay out of the subset);
 *  - outer pipes are optional; `\|` is the cell-pipe escape and becomes a
 *    literal `|` BEFORE inline parsing, so it works inside code spans (GFM);
 *  - the header's column count is the table's: a short body row is padded
 *    with empty cells, a long one drops its excess cells (GFM's rule — it is
 *    the one place this parser discards text, and it is what every GFM
 *    renderer the model was trained against does too);
 *  - the table ends at a blank line, a heading / fence / list line, or ANY
 *    line without an unescaped pipe (GFM would swallow pipe-less prose as a
 *    row; chat prose after a table is prose).
 *  Streaming: the delimiter row must be a COMPLETE line (followed by a
 *  newline) before the table forms — until then the header + partial
 *  delimiter are a two-line paragraph. That is a one-way disambiguation of
 *  the trailing open block, chosen over eager recognition so a half-typed
 *  `:-:` cell never flaps paragraph→table→paragraph. Body rows stream
 *  naturally: the last row is whatever has arrived, with its last cell's
 *  inline constructs `closed: false` as usual. A table has no closing marker
 *  (like a list), so it carries no `closed` flag.
 *
 * Deliberately OUT of the v1 subset (parse as plain text; future spec-process
 * additions, not silent behavior): images, blockquotes, strikethrough,
 * autolinked bare URLs, nested lists (indented bullets FLATTEN into the open
 * list), block content inside list items, table cell spans, and `setext`
 * headings.
 */

// ─── AST types ────────────────────────────────────────────────────────────────

/** Inline content. `closed: false` marks a construct still open mid-stream. */
export type RichTextInline =
  | { type: "text"; text: string }
  /** Explicit line break — a single newline inside a paragraph/heading/item.
   *  Chat prose is line-broken; hosts map this to <br/> / "\n", never a space. */
  | { type: "break" }
  | { type: "strong"; children: RichTextInline[]; closed: boolean }
  | { type: "em"; children: RichTextInline[]; closed: boolean }
  | { type: "code"; code: string; closed: boolean }
  | {
      type: "link";
      children: RichTextInline[];
      /**
       * The navigable target — populated ONLY when the written target passed
       * the scheme allowlist (http:, https:, mailto:). `undefined` means
       * "style as a link if you like, but there is nothing safe to open".
       */
      href: string | undefined;
      /**
       * The target VERBATIM as written (lossless — may be a partial mid-stream
       * fragment or a rejected scheme). NEVER navigate to this; it exists for
       * audit/debug display only. `href` is the only navigable field.
       */
      rawHref: string;
      closed: boolean;
    };

export type RichTextListItem = { children: RichTextInline[] };

/** Column alignment from a table's delimiter row (`:--` / `:-:` / `--:`). */
export type RichTextTableAlign = "left" | "center" | "right";
/** One table cell — inline content only (no block content inside cells). */
export type RichTextTableCell = { children: RichTextInline[] };
/** One table row. `cells.length` always equals the table's column count. */
export type RichTextTableRow = { cells: RichTextTableCell[] };

/** Block content. Order is the render order. */
export type RichTextBlock =
  | { type: "paragraph"; children: RichTextInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: RichTextInline[] }
  | {
      type: "code-fence";
      code: string;
      /** The info string's first word (```ts → "ts"), if any. */
      lang: string | undefined;
      closed: boolean;
    }
  | {
      type: "list";
      ordered: boolean;
      /** First item's number for an ordered list (1. / 3. …), else undefined. */
      start: number | undefined;
      items: RichTextListItem[];
    }
  | {
      type: "table";
      /**
       * Per-column alignment from the delimiter row, `undefined` where the
       * column declared none (`---`) — hand it straight to `textAlign`. Its
       * length is the table's column count; every row has exactly that many
       * cells.
       */
      align: (RichTextTableAlign | undefined)[];
      /** The header row (the line above the delimiter row). */
      header: RichTextTableRow;
      /** Body rows, in order. Mid-stream, the last row is the partial line so far. */
      rows: RichTextTableRow[];
    };

// ─── safety policy: link scheme allowlist ─────────────────────────────────────

// http/https/mailto ONLY. Case-insensitive; whitespace and control characters
// in the written target disqualify rather than get cleaned (a target that
// needs cleaning is not a target the model wrote cleanly).
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s\x00-\x1f]+$/i;

/** The one place the navigable-target decision is made (workspace#8 policy). */
function safeHref(raw: string): string | undefined {
  return SAFE_HREF.test(raw) ? raw : undefined;
}

// ─── inline parser ────────────────────────────────────────────────────────────
// Recursive descent with an explicit closer stack. `closers` is innermost-
// first; a delimiter that matches ANY active closer unwinds to that frame —
// the frames it skips over close as `closed: false` (fail-soft: `**a *b** c`
// closes the strong; the dangling em inside it stays open-but-stable).

type Closer = "**" | "__" | "*" | "_" | "]";

interface InlineResult {
  children: RichTextInline[];
  /** Index into `closers` of the OUTERMOST frame the ending delimiter run closed, or -1 for end-of-input. */
  closedBy: number;
  /**
   * Every `closers` index the run closed (a *** run can close an em AND its
   * strong at once) — each unwind level reads its own frame's flag from here.
   */
  closedIdxs: ReadonlySet<number>;
  /** Run characters consumed by those closes — the outermost consumer advances past them. */
  runConsumed: number;
  pos: number;
}

/** Shift a closer-index set down one stack level (drop this frame's own slot). */
function shiftIdxs(idxs: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const i of idxs) if (i > 0) out.add(i - 1);
  return out;
}

function isWs(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\t" || ch === "\n";
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

// Flanking rules — the pragmatic subset of CommonMark's:
//  *  opens when followed by non-space; closes when preceded by non-space.
//  _  additionally must sit at a word BOUNDARY on its outer side, so
//     snake_case_identifiers in prose never italicize (the reason CommonMark
//     has the rule; agents emit identifiers constantly).
function canOpen(marker: Closer, prev: string | undefined, next: string | undefined): boolean {
  if (isWs(next)) return false;
  if (marker === "_" || marker === "__") return !isWordChar(prev);
  return true;
}
function canClose(marker: Closer, prev: string | undefined, next: string | undefined): boolean {
  if (isWs(prev)) return false;
  if (marker === "_" || marker === "__") return !isWordChar(next);
  return true;
}

// Backslash escapes: exactly ASCII punctuation (CommonMark's set) — `\*` is a
// literal asterisk; `\n` (the letter n) is just "\" + "n".
const ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function parseInlineFrom(src: string, start: number, closers: Closer[]): InlineResult {
  const children: RichTextInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      children.push({ type: "text", text: buf });
      buf = "";
    }
  };

  let pos = start;
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === undefined) break;

    // Backslash escape.
    if (ch === "\\") {
      const next = src[pos + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        pos += 2;
        continue;
      }
      buf += ch;
      pos += 1;
      continue;
    }

    // Explicit line break (paragraph lines are joined with "\n" upstream).
    if (ch === "\n") {
      flush();
      children.push({ type: "break" });
      pos += 1;
      continue;
    }

    // Inline code span — verbatim until the closing backtick (newlines
    // included: a span the stream hasn't closed yet swallows softly, and a
    // genuine multi-line span renders fine under code styling). No nested
    // markdown inside.
    if (ch === "`") {
      flush();
      const end = src.indexOf("`", pos + 1);
      if (end === -1) {
        children.push({ type: "code", code: src.slice(pos + 1), closed: false });
        pos = src.length;
        continue;
      }
      children.push({ type: "code", code: src.slice(pos + 1, end), closed: true });
      pos = end + 1;
      continue;
    }

    // Emphasis delimiters. Closing is checked BEFORE opening so `**bold**`'s
    // second ** seals rather than re-opens.
    if (ch === "*" || ch === "_") {
      const two = src.slice(pos, pos + 2);
      const double: Closer | undefined = two === "**" || two === "__" ? (two as Closer) : undefined;
      const single = ch as Closer;
      const prev = pos > 0 ? src[pos - 1] : undefined;

      // Measure the whole delimiter run, then walk the open frames OUTERMOST-
      // first (link brackets bound the walk — emphasis never closes across a
      // `[`), spending the run's characters on every closeable frame: a **
      // run seals the strong (its inner em dangles soft — `**a *b** c`), a
      // *** run seals the em AND the strong. The closure SET rides the unwind
      // so every level marks its own `closed` flag accurately.
      let runLen = 1;
      while (src[pos + runLen] === ch) runLen++;
      const nextAfterRun = src[pos + runLen];
      const bracket = closers.indexOf("]");
      const bound = bracket === -1 ? closers.length - 1 : bracket - 1;
      const closedIdxs = new Set<number>();
      let budget = runLen;
      for (let ci = bound; ci >= 0; ci--) {
        const m = closers[ci];
        if (m === undefined || m[0] !== ch) continue;
        if (m.length > budget) continue;
        if (!canClose(m, prev, nextAfterRun)) continue;
        closedIdxs.add(ci);
        budget -= m.length;
        if (budget === 0) break;
      }
      if (closedIdxs.size > 0) {
        flush();
        return {
          children,
          closedBy: Math.max(...closedIdxs),
          closedIdxs,
          runConsumed: runLen - budget,
          pos,
        };
      }

      // Opening reads the longest marker (** before *); a double that cannot
      // open stays a literal double, never a half-open single.
      const marker: Closer = double ?? single;
      const next = src[pos + marker.length];
      if (canOpen(marker, prev, next)) {
        flush();
        const inner = parseInlineFrom(src, pos + marker.length, [marker, ...closers]);
        const node: RichTextInline =
          marker === "**" || marker === "__"
            ? { type: "strong", children: inner.children, closed: inner.closedIdxs.has(0) }
            : { type: "em", children: inner.children, closed: inner.closedIdxs.has(0) };
        children.push(node);
        if (inner.closedBy === 0) {
          // This frame is the OUTERMOST one the run closed — consume the
          // run's whole closed span here.
          pos = inner.pos + inner.runConsumed;
          continue;
        }
        if (inner.closedBy === -1) {
          // End of input — everything is flushed; this frame ends open too.
          pos = inner.pos;
          continue;
        }
        // The run reached an OUTER frame: keep unwinding (shift the set past
        // this frame's own stack slot).
        return {
          children,
          closedBy: inner.closedBy - 1,
          closedIdxs: shiftIdxs(inner.closedIdxs),
          runConsumed: inner.runConsumed,
          pos: inner.pos,
        };
      }
      buf += marker;
      pos += marker.length;
      continue;
    }

    // Link: [children](target). `[text]` followed by anything but "(" is the
    // literal bracket text it always was; `[text]` at END of input stays an
    // open link — the "(url)" may still be in flight (fail-soft, documented).
    if (ch === "[") {
      const inner = parseInlineFrom(src, pos + 1, ["]", ...closers]);
      if (inner.closedBy > 0) {
        // An outer delimiter fired inside the bracket — the bracket is literal.
        buf += "[";
        pos += 1;
        continue;
      }
      if (inner.closedBy === -1) {
        // Input ended inside [ … — an open link with no target yet.
        flush();
        children.push({ type: "link", children: inner.children, href: undefined, rawHref: "", closed: false });
        pos = inner.pos;
        continue;
      }
      const afterBracket = inner.pos + 1;
      const paren = src[afterBracket];
      if (paren === "(") {
        const close = src.indexOf(")", afterBracket + 1);
        if (close === -1) {
          // Target still streaming — style the text, expose NO href yet.
          const partial = src.slice(afterBracket + 1);
          flush();
          children.push({ type: "link", children: inner.children, href: undefined, rawHref: partial, closed: false });
          pos = src.length;
          continue;
        }
        // `(url "title")` tolerance: the target is the first whitespace-run-
        // delimited word; anything after it inside the parens is ignored.
        const rawHref = (src.slice(afterBracket + 1, close).trim().split(/\s+/)[0] ?? "");
        flush();
        children.push({ type: "link", children: inner.children, href: safeHref(rawHref), rawHref, closed: true });
        pos = close + 1;
        continue;
      }
      if (paren === undefined) {
        // Input ended exactly at `[text]` — the "(" may still arrive.
        flush();
        children.push({ type: "link", children: inner.children, href: undefined, rawHref: "", closed: false });
        pos = afterBracket;
        continue;
      }
      // `[text]` followed by something else — literal brackets.
      buf += "[";
      pos += 1;
      continue;
    }

    // "]" only matters when a link frame is open.
    if (ch === "]" && closers.includes("]")) {
      const closerIdx = closers.indexOf("]");
      flush();
      return { children, closedBy: closerIdx, closedIdxs: new Set([closerIdx]), runConsumed: 1, pos };
    }

    buf += ch;
    pos += 1;
  }

  flush();
  return { children, closedBy: -1, closedIdxs: new Set(), runConsumed: 0, pos };
}

/**
 * Parse a single run of inline content (no block structure). Useful when a
 * host renders one-line strings (labels, list items it assembled itself).
 */
export function parseInlineRichText(text: string): RichTextInline[] {
  return parseInlineFrom(text, 0, []).children;
}

// ─── block parser ─────────────────────────────────────────────────────────────

const FENCE_OPEN = /^```+\s*(\S*)\s*$/;
const FENCE_CLOSE = /^```+\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
// Leading indent is ACCEPTED and flattened (nested lists are a documented
// future addition, not silent structure loss — the items are all kept, in
// order, in the one open list).
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

// ── tables (GFM pipe subset) ──
// A delimiter cell: optional colon, one-or-more hyphens, optional colon.
const DELIMITER_CELL = /^(:?)-+(:?)$/;

/**
 * Split a line into raw (trimmed) cell strings on its UNESCAPED pipes, or
 * `undefined` when the line has none (then it is not a table row at all).
 * Splitting happens BEFORE inline parsing (GFM): `\|` is the cell-pipe
 * escape and is replaced by a literal `|` here so it survives even inside a
 * code span; every other backslash pair passes through untouched for the
 * inline parser to interpret. One outer leading/trailing pipe is structural
 * and dropped; anything between is content (empty cells included).
 */
function splitTableRow(line: string): string[] | undefined {
  const s = line.trim();
  const cells: string[] = [];
  let buf = "";
  let sawPipe = false;
  let endedWithPipe = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    endedWithPipe = false;
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      buf += next === "|" ? "|" : ch + next;
      i += 1;
      continue;
    }
    if (ch === "|") {
      sawPipe = true;
      endedWithPipe = true;
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (!sawPipe) return undefined;
  cells.push(buf);
  if (s.startsWith("|")) cells.shift();
  if (endedWithPipe) cells.pop();
  return cells.map((c) => c.trim());
}

/** The delimiter row's alignment vector, or `undefined` if any cell is not a delimiter cell. */
function delimiterAlignment(cells: string[]): (RichTextTableAlign | undefined)[] | undefined {
  if (cells.length === 0) return undefined;
  const out: (RichTextTableAlign | undefined)[] = [];
  for (const c of cells) {
    const m = c.match(DELIMITER_CELL);
    if (m === null) return undefined;
    const left = m[1] === ":";
    const right = m[2] === ":";
    out.push(left && right ? "center" : left ? "left" : right ? "right" : undefined);
  }
  return out;
}

/** Fit raw cells to the column count (GFM: pad short rows, drop excess) and inline-parse each. */
function tableRow(cells: string[], columns: number): RichTextTableRow {
  const fitted = cells.slice(0, columns);
  while (fitted.length < columns) fitted.push("");
  return { cells: fitted.map((c) => ({ children: parseInlineFrom(c, 0, []).children })) };
}

/**
 * Parse a chat text block into the rich-text AST. Pure and total: any string
 * (including any prefix of a longer one) parses without throwing.
 */
export function parseRichText(text: string): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  const lines = text.split("\n");

  // Accumulators for the (single) open block.
  let para: string[] = [];
  let list: { ordered: boolean; start: number | undefined; items: RichTextListItem[] } | undefined;
  let table: Extract<RichTextBlock, { type: "table" }> | undefined;

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", children: parseInlineFrom(para.join("\n"), 0, []).children });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list !== undefined) {
      blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
      list = undefined;
    }
  };
  const flushTable = (): void => {
    if (table !== undefined) {
      blocks.push(table);
      table = undefined;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Fenced code — verbatim until the closing fence (or end of input:
    // closed:false, content-so-far intact).
    const fence = line.match(FENCE_OPEN);
    if (fence !== null) {
      flushPara();
      flushList();
      flushTable();
      const lang = fence[1] !== undefined && fence[1].length > 0 ? fence[1] : undefined;
      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l !== undefined && FENCE_CLOSE.test(l)) {
          closed = true;
          break;
        }
        body.push(l ?? "");
      }
      blocks.push({ type: "code-fence", code: body.join("\n"), lang, closed });
      i = j;
      continue;
    }

    if (line.trim().length === 0) {
      flushPara();
      flushList();
      flushTable();
      continue;
    }

    const heading = line.match(HEADING);
    if (heading !== null && heading[1] !== undefined) {
      flushPara();
      flushList();
      flushTable();
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInlineFrom(heading[2] ?? "", 0, []).children });
      continue;
    }

    const ordered = line.match(ORDERED);
    const bullet = ordered === null ? line.match(BULLET) : null;
    if (ordered !== null || bullet !== null) {
      flushPara();
      flushTable();
      const isOrdered = ordered !== null;
      const content = (isOrdered ? ordered[2] : bullet?.[1]) ?? "";
      // A same-orderedness item continues the open list; a switch (1. → -)
      // closes it and opens the other kind.
      if (list !== undefined && list.ordered !== isOrdered) flushList();
      if (list === undefined) {
        list = {
          ordered: isOrdered,
          start: isOrdered && ordered[1] !== undefined ? parseInt(ordered[1], 10) : undefined,
          items: [],
        };
      }
      list.items.push({ children: parseInlineFrom(content, 0, []).children });
      continue;
    }

    // Table rows (GFM pipe subset — see the module doc). An open table takes
    // every line with an unescaped pipe; a pipe-less line ends it and is
    // prose. A table OPENS when a complete delimiter row (a newline follows
    // it) matches the cell count of the line just above it: that line leaves
    // the open paragraph to become the header; the paragraph's earlier lines
    // flush as their own block.
    const cells = splitTableRow(line);
    if (table !== undefined) {
      if (cells !== undefined) {
        table.rows.push(tableRow(cells, table.align.length));
        continue;
      }
      flushTable();
    } else if (cells !== undefined && para.length > 0 && i < lines.length - 1) {
      const align = delimiterAlignment(cells);
      const headerLine = para[para.length - 1];
      const headerCells = align !== undefined && headerLine !== undefined ? splitTableRow(headerLine) : undefined;
      if (align !== undefined && headerCells !== undefined && headerCells.length === align.length) {
        para.pop();
        flushPara();
        flushList();
        table = { type: "table", align, header: tableRow(headerCells, align.length), rows: [] };
        continue;
      }
    }

    // Plain prose. A non-bullet line after a list ENDS the list (predictable
    // for chat; lazy continuation is not part of the v1 subset).
    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  flushTable();
  return blocks;
}

export default parseRichText;
