#!/usr/bin/env node
/**
 * SPEC.md ↔ agjson.ts wire-type drift gate (audit M56 fix, part 2).
 *
 * Guards that every `AgEvent.type` literal and `AgInput.kind` literal named
 * in the AgJSON spec text (`SPEC.md`) has a matching `z.literal(...)` arm in
 * the reference schema (`packages/core/src/agjson.ts`), and vice versa.
 * Style precedent: guuey's `scripts/check-spec-drift.mjs` (structural
 * interface-field diffing) — this checker instead diffs closed SETS of
 * string-literal discriminants, which is the shape SPEC.md §3/§4 actually
 * declare. Zero deps, pure Node.
 *
 * # What is compared
 *
 * 1. **AgEvent `type` literals** — every quoted `type: "…"` discriminant
 *    inside SPEC.md §4's `type AgEvent = …;` union block, versus every
 *    `type: z.literal("…")` arm inside agjson.ts's `AgClosedEvent`
 *    discriminated union. Per spec §0.3 three bare-noun events (`error`,
 *    `source`, `handoff`) are enumerated carve-outs, not dotted — the
 *    extraction regex admits dotless nouns too, so they fall out naturally;
 *    no special-casing needed.
 * 2. **The `ext.<vendor>.<key>` template arm** — SPEC.md's open vendor-
 *    extension type is a TEMPLATE LITERAL TYPE
 *    (`` type: `ext.${string}.${string}` ``), not a plain string literal, so
 *    it can't match the `type: "…"` regex above and can't be a
 *    `z.literal(...)` in agjson.ts (open discriminants can't live in a
 *    `discriminatedUnion` — see `AgExtEvent`'s comment there). Both sides
 *    are checked for PRESENCE of their respective open-extension spelling
 *    and, when present, contribute one shared sentinel token to both sets so
 *    a side that quietly drops its open-extension support is caught like
 *    any other set-membership drift.
 * 4. **AgUsage field set** — every `name?:` member of SPEC.md §4's
 *    `interface AgUsage { … }` block, versus agjson.ts's `export interface
 *    AgUsage { … }` members and its `AgUsage` zod object's keys. The interface
 *    and the zod object must carry the same keys (a hand-synced pair, both
 *    ways), and every interface key must be defined in SPEC.md (a field the
 *    reference carries but the spec does not define is drift); a field SPEC.md
 *    defines that the reference does not carry yet is reported as advisory,
 *    not drift (the spec text may land ahead of its schema half).
 *
 * 3. **AgInput `kind` literals** — every quoted `kind: "…"` discriminant
 *    inside SPEC.md §3's `type AgInput = …;` union block, versus every
 *    `kind: z.literal("…")` arm inside agjson.ts's `AgInput`
 *    discriminated union.
 *
 * Each family is compared as a SET in both directions (present-in-SPEC-
 * missing-in-schema, and the reverse); a non-empty delta on either side
 * fails the gate.
 *
 * # Usage
 *
 *   node scripts/check-spec-drift.mjs              # verify repo state
 *   node scripts/check-spec-drift.mjs --self-test   # run negative-case proof
 *
 * `--self-test` re-runs the AgEvent comparison against an in-memory-mutated
 * copy of SPEC.md (one union arm's `type` literal renamed) and asserts the
 * checker reports BOTH the injected phantom literal and the now-missing real
 * one. This proves the detector can actually fail (M58's lesson — a gate
 * that cannot fail is a defect — applied to the gate itself).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const scriptDir = import.meta.dirname;
// The canonical spec lives in the neutral flagship (protocol/SPEC.md ->
// github.com/silverprotocol/AgJSON). This SDK vendors a byte-identical
// FOLLOWER copy at its subtree root, synced from the canonical via
// protocol/scripts/sync-spec.mjs, so this gate can resolve a SPEC.md beside
// agjson.ts self-containedly — the same path resolves in both the private
// workspace umbrella and the public typescript-sdk mirror.
const specPath = resolve(scriptDir, "..", "SPEC.md");
const agjsonPath = resolve(scriptDir, "..", "packages", "core", "src", "agjson.ts");

const EXT_SENTINEL = "ext.<vendor>.<key>";

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

/**
 * Strip `/* … *\/` block comments and `// …` line comments from a
 * TS-flavored text (both SPEC.md's fenced code blocks and agjson.ts itself
 * use `//` prose comments that can contain a bare `;`, which would
 * false-terminate the depth-0 statement scan below). The `(^|[^:])` guard
 * on the line-comment pattern skips a `//` immediately preceded by `:` so
 * `https://…` URLs survive.
 */
function stripComments(src, { block = true } = {}) {
  const noBlocks = block ? src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")) : src; // newlines kept so every `agjson.ts:<line>` in a finding is the real line // SPEC.md is Markdown: its prose can carry a bare `/*` (`video/*`), so only `//` trailers are stripped there
  return noBlocks.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Slice a `name STARTMARKER … ;` top-level statement out of `src`, starting
 * at the first occurrence of `startMarker`. Tracks `{`, `(`, `[` depth so
 * semicolons nested inside object/tuple literals (including the ones inside
 * a `` `${string}` `` template — its braces balance locally) don't
 * false-terminate the scan; returns the substring up to and including the
 * first `;` seen at depth 0. Returns null if `startMarker` or a terminating
 * top-level `;` isn't found.
 */
function extractStatement(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * Slice a `constMarker … ]);` region out of `src` — used for the two
 * agjson.ts `z.discriminatedUnion("…", [ … ]);` declarations. Tracks the
 * same bracket set as `extractStatement`; returns the substring up to and
 * including the closing `]);` at depth 0 (the `[` that opens the arm array
 * is consumed as part of the initial descent, so depth returns to 0 exactly
 * at that `]`). Returns null if not found.
 */
function extractBracketedRegion(src, constMarker) {
  const start = src.indexOf(constMarker);
  if (start === -1) return null;
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      seenOpen = true;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (seenOpen && depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** All quoted values of `fieldName: "…"` inside `text`, in order of appearance. */
function extractQuotedField(text, fieldName) {
  const re = new RegExp(`\\b${fieldName}:\\s*"([a-zA-Z][a-zA-Z0-9.\\-]*)"`, "g");
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** All `fieldName: z.literal("…")` values inside `text`, in order of appearance. */
function extractZodLiteralField(text, fieldName) {
  const re = new RegExp(`\\b${fieldName}:\\s*z\\.literal\\("([a-zA-Z][a-zA-Z0-9.\\-]*)"\\)`, "g");
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Set difference as a sorted array: elements of `a` not present in `b`. */
function setMinus(a, b) {
  const bSet = new Set(b);
  return [...new Set(a)].filter((x) => !bSet.has(x)).sort();
}

// -----------------------------------------------------------------------------
// Family extraction
// -----------------------------------------------------------------------------

/**
 * Extract the AgEvent `type` literal set (§4) plus the ext-template
 * sentinel, from SPEC.md full text.
 */
function extractSpecEventTypes(specText) {
  const block = extractStatement(specText, "type AgEvent =");
  if (block == null) {
    throw new Error("SPEC.md: `type AgEvent = …;` union not found under §4");
  }
  const types = extractQuotedField(block, "type");
  if (/`ext\.\$\{string\}\.\$\{string\}`/.test(block)) types.push(EXT_SENTINEL);
  return types;
}

/**
 * Extract the AgClosedEvent + AgExtEvent `type` literal set from agjson.ts
 * full text.
 */
function extractSchemaEventTypes(tsText) {
  const region = extractBracketedRegion(
    tsText,
    'export const AgClosedEvent = z.discriminatedUnion("type", [',
  );
  if (region == null) {
    throw new Error("agjson.ts: `AgClosedEvent` discriminated union not found");
  }
  const types = extractZodLiteralField(region, "type");
  // The open ext.<vendor>.<key> arm lives in the sibling AgExtEvent const,
  // validated via a regex (not a z.literal — see the AgExtEvent comment).
  const extMatch = /export const AgExtEvent[\s\S]*?type:\s*z\.string\(\)\.regex\(\/\^ext\\\.\[\^\.\]\+\\\..*?\/\)/.exec(
    tsText,
  );
  if (extMatch) types.push(EXT_SENTINEL);
  return types;
}

/** Extract the AgInput `kind` literal set (§3) from SPEC.md full text. */
function extractSpecInputKinds(specText) {
  const block = extractStatement(specText, "type AgInput =");
  if (block == null) {
    throw new Error("SPEC.md: `type AgInput = …;` union not found under §3");
  }
  return extractQuotedField(block, "kind");
}

/** Extract the AgInput `kind` literal set from agjson.ts full text. */
function extractSchemaInputKinds(tsText) {
  const region = extractBracketedRegion(
    tsText,
    'export const AgInput = z.discriminatedUnion("kind", [',
  );
  if (region == null) {
    throw new Error("agjson.ts: `AgInput` discriminated union not found");
  }
  return extractZodLiteralField(region, "kind");
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

/** `name?:` members of the first `interface AgUsage { … }` block in `text`. */
function extractUsageInterfaceFields(text, label) {
  const start = text.indexOf("interface AgUsage {");
  if (start < 0) throw new Error(`${label}: \`interface AgUsage { … }\` block not found`);
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\?:/g)].map((m) => m[1]);
}

/** Keys of the `z.object({ … })` inside agjson.ts's `export const AgUsage` statement. */
function extractUsageZodFields(tsText) {
  const stmt = extractStatement(tsText, "export const AgUsage");
  if (!stmt) throw new Error("agjson.ts: `export const AgUsage` statement not found");
  const open = stmt.indexOf("z.object({");
  if (open < 0) throw new Error("agjson.ts: `z.object({` not found inside `export const AgUsage`");
  const body = stmt.slice(open + "z.object({".length);
  return [...body.matchAll(/(?:^|[\s{,])([a-zA-Z_][a-zA-Z0-9_]*):\s*z\./g)].map((m) => m[1]);
}

/**
 * Compare two literal sets both directions. Returns a list of finding lines
 * (empty = clean).
 */
function compareSets(label, specValues, schemaValues, sides = ["SPEC.md", "agjson.ts"]) {
  const findings = [];
  const [left, right] = sides;
  const missingFromSchema = setMinus(specValues, schemaValues);
  const missingFromSpec = setMinus(schemaValues, specValues);
  if (missingFromSchema.length > 0) {
    findings.push(
      `  ${label}: in ${left} but missing from ${right}: ${missingFromSchema.join(", ")}`,
    );
  }
  if (missingFromSpec.length > 0) {
    findings.push(
      `  ${label}: in ${right} but missing from ${left}: ${missingFromSpec.join(", ")}`,
    );
  }
  return findings;
}


// ─── 5. §12 closed-set table ↔ agjson.ts closed sets (draft.8) ───────────────
// SPEC.md §12's "Closed sets in major 1" table is the normative list of every
// closed set on the wire. This check keeps it and agjson.ts in lockstep three
// ways: (a) every row is well-formed (seven cells; a known class; a known
// direction); (b) every backticked reference in a row's `where` cell resolves
// in agjson.ts — an export or module const (`AgRole`, `citationHead`), a
// dotted member path (`AgTurnRecord.promptBlocked.reason`), or an event/block
// arm field (`AgClosedEvent[hitl.ask].continuation`, `AgBlock[code-result].outcome`);
// (c) every `z.enum([...])` site in agjson.ts is named by some row's `where`
// cell, and no row classed OPEN STRING names a site agjson.ts still closes
// with `z.enum`. Rows whose class is ADDITIVE-EVENT, BLOCK-KIND or
// SPEC-INTERNAL, and the `AgEvent.type` / `AgInput.kind` rows, are covered
// by checks 1-3 above and are exempt from (c).
const TABLE_HEADER = "| set | where | class |";
const TABLE_CLASSES = ["FROZEN", "OPEN STRING", "ADDITIVE-EVENT", "BLOCK-KIND", "SPEC-INTERNAL"];
const TABLE_DIRECTIONS = ["in", "out", "both", "—"];
// z.enum sites represented by another row's set (their values equal that set's).
const TABLE_ENUM_ALIASES = { "AgMcpAppViewMessage.mode": "`AgDisplayMode`", "AgOpenAiWidgetAction.mode": "`AgDisplayMode`" };

function extractSpecClosedSetTable(specText) {
  const lines = specText.split("\n");
  const h = lines.findIndex((l) => l.startsWith(TABLE_HEADER));
  if (h < 0) throw new Error(`SPEC.md: §12 closed-set table header \`${TABLE_HEADER}\` not found`);
  const rows = [];
  for (let i = h + 2; i < lines.length && lines[i].startsWith("| "); i++) {
    const cells = lines[i].split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length !== 7) throw new Error(`SPEC.md §12 table, line ${i + 1}: expected 7 cells, got ${cells.length}`);
    rows.push({ line: i + 1, set: cells[0], where: cells[1], cls: cells[2], direction: cells[3] });
  }
  if (rows.length === 0) throw new Error("SPEC.md §12 closed-set table has no rows");
  return rows;
}

function tableClass(cell) {
  const bare = cell.replace(/\*\*/g, "").replace(/\s*\(.*$/, "").trim();
  return TABLE_CLASSES.find((c) => bare === c || bare.startsWith(c + " ")) ?? null;
}

/** The comment-stripped declaration region of a top-level `export const|type|interface NAME` or module `const NAME`. */
function declarationRegion(tsText, name) {
  const m = new RegExp(`^(?:export )?(?:const|type|interface|function) ${name}\\b`, "m").exec(tsText);
  if (!m) return null;
  const rest = tsText.slice(m.index + m[0].length);
  const next = /\nexport /.exec(rest);
  return tsText.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
}

/** The region of an `AgClosedEvent` / `AgBlock` arm, from its `type: z.literal("…")` discriminant. */
function armRegion(tsText, arm) {
  const k = tsText.indexOf(`type: z.literal("${arm}")`);
  return k < 0 ? null : tsText.slice(k, k + 4000);
}

/** null when `ref` resolves in agjson.ts, else the reason it does not. */
function resolveTableReference(tsText, ref) {
  const armRef = /^(AgClosedEvent|AgBlock)\[([a-z][a-z0-9.\-]*)\]\.(\w+(?:\.\w+)*)$/.exec(ref);
  if (armRef) {
    const region = armRegion(tsText, armRef[2]);
    if (!region) return `no \`type: z.literal("${armRef[2]}")\` arm`;
    for (const member of armRef[3].split(".")) if (!new RegExp(`\\b${member}\\s*:`).test(region)) return `arm ${armRef[2]} has no member \`${member}\``;
    return null;
  }
  if (/[\[\]]/.test(ref.replace(/\[\]/g, ""))) return `\`${ref}\` is not a location this check can resolve (expected \`Export.member\`, \`Export.array[].member\` or \`AgClosedEvent|AgBlock[arm].member\`)`;
  const [root, ...path] = ref.split(".").map((x) => x.replace(/\[\]$/, ""));
  const region = declarationRegion(tsText, root);
  if (!region) return `no declaration of \`${root}\``;
  for (const member of path) {
    if (!new RegExp(`\\b${member}\\s*:`).test(region)) return `\`${root}\` declares no member \`${member}\``;
  }
  return null;
}

/** Every `z.enum([...])` site in agjson.ts: `{ key }` where key is `Scope.field` (an export or module const), `AgClosedEvent[arm].field`, `AgBlock[kind].field` or a bare export name. */
function extractSchemaEnumSites(tsText) {
  const lines = tsText.split("\n");
  const sites = [];
  let exportName = null;
  let arm = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ex = /^(?:export )?(?:const|type|interface) (\w+)/.exec(l);
    if (ex) { exportName = ex[1]; arm = null; }
    const disc = /type: z\.literal\("([a-z][a-z0-9.\-]*)"\)/.exec(l);
    if (disc && (exportName === "AgClosedEvent" || exportName === "AgBlock")) arm = disc[1];
    const bare = /^export const (\w+) = z\.enum\(/.exec(l);
    if (bare) { sites.push({ key: bare[1], line: i + 1 }); continue; }
    const field = /^\s*(\w+):\s*z\.(?:array\()?z\.enum\(/.exec(l) ?? /^\s*(\w+):\s*z\.enum\(/.exec(l);
    if (field && exportName) {
      const key = arm && (exportName === "AgClosedEvent" || exportName === "AgBlock") ? `${exportName}[${arm}].${field[1]}` : `${exportName}.${field[1]}`;
      sites.push({ key, line: i + 1 });
    }
  }
  return sites;
}

function checkClosedSetTable(specText, tsText) {
  const findings = [];
  const rows = extractSpecClosedSetTable(specText);
  const whereText = rows.map((r) => r.where).join("\n");
  for (const r of rows) {
    const cls = tableClass(r.cls);
    if (!cls) findings.push(`  §12 table line ${r.line} (${r.set}): class \`${r.cls}\` is not one of ${TABLE_CLASSES.join(" | ")}`);
    if (!TABLE_DIRECTIONS.includes(r.direction)) findings.push(`  §12 table line ${r.line} (${r.set}): direction \`${r.direction}\` is not one of ${TABLE_DIRECTIONS.join(" | ")}`);
    for (const m of r.where.matchAll(/`([^`]+)`/g)) {
      const ref = m[1];
      if (ref.startsWith("§") || /^[a-z]/.test(ref)) continue; // section pointers and prose event paths are not schema references
      const why = resolveTableReference(tsText, ref);
      if (why) findings.push(`  §12 table line ${r.line} (${r.set}): \`${ref}\` does not resolve in agjson.ts — ${why}`);
    }
  }
  // (c) coverage: every z.enum site is named by a row; an OPEN STRING row must not name a z.enum site.
  const sites = extractSchemaEnumSites(tsText);
  // every backticked reference in every `where` cell, as { row, full, root, last }
  const refs = rows.flatMap((r) => [...r.where.matchAll(/`([^`]+)`/g)].map((m) => {
    const full = m[1];
    const armRef = /^(AgClosedEvent|AgBlock)\[[^\]]+\]\.(\w+)$/.exec(full);
    const parts = full.split(".").map((x) => x.replace(/\[\]$/, ""));
    return { row: r, full, root: armRef ? full.slice(0, full.indexOf("]") + 1) : parts[0], last: armRef ? armRef[2] : parts[parts.length - 1] };
  }));
  const names = (site) => {
    const alias = TABLE_ENUM_ALIASES[site.key];
    if (alias) return refs.filter((x) => x.row.set === alias);
    const armKey = /^(AgClosedEvent\[[^\]]+\]|AgBlock\[[^\]]+\])\.(\w+)$/.exec(site.key);
    if (armKey) return refs.filter((x) => x.full === site.key);
    const [root, field] = site.key.includes(".") ? site.key.split(".") : [site.key, null];
    return refs.filter((x) => x.root === root && (field === null ? x.full === root : x.last === field));
  };
  for (const site of sites) {
    const naming = names(site);
    if (naming.length === 0) findings.push(`  agjson.ts closes \`${site.key}\` with z.enum but no §12 table row's \`where\` cell names it`);
    for (const x of naming) {
      if (tableClass(x.row.cls) === "OPEN STRING") findings.push(`  §12 table line ${x.row.line} (${x.row.set}) is classed OPEN STRING but agjson.ts still closes \`${site.key}\` with z.enum`);
    }
  }
  return { findings, rows: rows.length, sites: sites.length };
}


// ─── 6. SPEC's closed unions ↔ agjson.ts's z.enum sites, bound through the §12 table (draft.8) ──
// SPEC.md writes closed sets inline as TypeScript unions inside its ```ts fences (`kind: "approval" |
// "form" | …`, `type AgRole = …`, the multi-line `type AgFinishReason =`, unions on `| { type: … }`
// arms and inside nested object fields). Each such union is resolved to its OWNER and path
// (interface / type alias / AgEvent, AgBlock and AgInput arm), mapped to the §12 row whose `set`
// or `where` cell names that location (SPEC_LOCATION_MAP spells the few SPEC-side spellings the
// table does not), and compared — as a value set — against EVERY z.enum site the same row names.
// So: (a) a value added or removed on either side of a row is drift; (b) a union no row names is
// a §12 completeness finding (never a silent match against some other set with the same values);
// (c) a row classed OPEN STRING may bind no SPEC closed union at any of its locations; (d) every
// z.enum site must be compared at least once (pinned) — this keyer reaches all 40 sites, the four
// check 5's does not included (AgCitationUnit, AgCitationBounds, AgRunConfig.toolChoice,
// AgMcpAppViewMessage.params.mode) — unless UNPINNED_SITE_EXCEPTIONS names it (empty today).
// `--census` prints every binding, the twin sites that share a row, and the location map.
const Q = /"([^"\n]+)"/g;
const TS_FENCE = /^\s*```(ts|typescript)\s*$/;
const FENCE_END = /^\s*```\s*$/;

// SPEC owner → schema location. Small, explicit, printed in the summary (a re-read checks the union resolved where intended).
const SPEC_LOCATION_MAP = {
  // (AgEvent[arm] → AgClosedEvent[arm] is applied by mapSpecLocation before this map is consulted; it is not an entry.)
  // AgInput arms by `kind:` → the named input schemas; the `results[]` item path is the schema's own shape
  "AgInput[start]": "AgInputStart", "AgInput[resume]": "AgInputResume", "AgInput[tool-result]": "AgInputToolResult",
  // SPEC inlines a record shape the schema names
  "AgTurnRecord.handoffs.kind": "AgHandoffRecord.kind",
  // the input's results[] item path, spelled without the array segment in the §12 row
  "AgInputToolResult.results.scheduling": "AgInputToolResult.scheduling",
  // SPEC inlines an export's set at a location the export covers in the schema
  "AgClosedEvent[reasoning.opaque].kind": "AgOpaque.kind",
  "AgInputToolResult.results.outcome": "ToolOutcome",
  "AgMcpAppViewMessage.params.mode": "AgDisplayMode", "AgOpenAiWidgetAction.mode": "AgDisplayMode",
  "AgClosedEvent[ui.display-mode].mode": "AgDisplayMode", "AgClosedEvent[ui.display-mode].granted": "AgDisplayMode",
};
// A ```ts block that opens with a bare object literal names no owner in the fence; its owner is fixed here by its first line.
const SPEC_BLOCK_OWNERS = { "{ type: \"hitl.ask\";": "AgEvent[hitl.ask]", "{ askId: string;": "AgHitlAnswer" };
// z.enum sites SPEC writes no closed union for (each entry names why); empty today.
const UNPINNED_SITE_EXCEPTIONS = {};
// The number of closed unions SPEC.md writes inside its ts fences at the current draft — a ratchet, like the
// fixture manifest: a SPEC edit that adds or removes a union updates it in the same commit, so a location that
// silently stops being read (a field retyped to an alias while its row stays pinned by another) fails --self-test.
const EXPECTED_SPEC_UNIONS = 54;
// The number of z.enum sites agjson.ts declares at the current draft — the same ratchet on the schema side: a site the
// keyer stops reaching (a chain-broken `z\n  .enum(`, a second z.enum on one line) or a site removed fails --self-test
// until the count is updated in the same commit.
const EXPECTED_ENUM_SITES = 40;

function stripTrailer(l) { return l.replace(/(?<!:)\/\/.*$/, ""); }
function braceDelta(l) { let d = 0, inStr = false; for (const ch of l) { if (ch === '"') inStr = !inStr; else if (!inStr) { if (ch === "{") d++; else if (ch === "}") d--; } } return d; }

/** Every closed union (≥2 quoted literals) inside SPEC.md's ts fences: { location, values, line, form }. */
function extractSpecUnions(specText) {
  // Only ```ts / ```typescript fences are read; a closed union written in any other fence is counted for --census (0 at the tip) and otherwise ignored.
  const lines = specText.split("\n"); const out = []; const problems = []; let otherFenceUnions = 0; let inOther = false;
  let inTs = false, owner = null, ownerIsAlias = false, arm = null, armDepth = 0, depth = 0, alias = null, blockOwnerPending = false;
  const path = []; // [{name, depth}] nested object fields opened by `name: {` / `name: Array<{`
  const locationOf = (field) => {
    let base = owner ?? "?"; if (arm !== null) base = `${owner ?? "AgEvent"}[${arm}]`;
    const p = [...path.map((x) => x.name), field].filter(Boolean).join(".");
    return p ? `${base}.${p}` : base;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!inTs) {
      if (TS_FENCE.test(raw)) { inTs = true; owner = null; arm = null; depth = 0; path.length = 0; alias = null; blockOwnerPending = true; continue; }
      if (inOther) { if (FENCE_END.test(raw)) inOther = false; else if (/\b[A-Za-z_]\w*\??\s*[:=]\s*(?:\(|Array<)?\s*"[^"\n]+"(?:\s*\|\s*"[^"\n]+")+/.test(raw)) otherFenceUnions++; }
      else if (/^\s*```/.test(raw)) inOther = true;
      continue;
    }
    if (FENCE_END.test(raw)) { if (alias && alias.values.length > 1) out.push({ location: alias.name, values: alias.values, line: alias.line, form: "alias" }); inTs = false; alias = null; continue; }
    const l = stripTrailer(raw); const t = l.trim(); let m;
    // block owner for a fence that opens with a bare object literal
    if (blockOwnerPending && t.length > 0) {
      blockOwnerPending = false;
      if (t.startsWith("{")) { const key = Object.keys(SPEC_BLOCK_OWNERS).find((k) => t.startsWith(k)); if (key) { const o = SPEC_BLOCK_OWNERS[key]; const am = /^(\w+)\[([^\]]+)\]$/.exec(o); if (am) { owner = am[1]; arm = am[2]; } else owner = o; } else { owner = "?"; problems.push(`SPEC.md:${i + 1} opens a ts block with a bare object literal whose owner SPEC_BLOCK_OWNERS does not name`); } }
    }
    // multi-line alias `type X =` followed by `| "a"` lines
    if (alias) {
      if ((m = /^\s*\|\s*("[^"\n]+"(?:\s*\|\s*"[^"\n]+")*)\s*;?\s*$/.exec(l))) { alias.values.push(...Array.from(m[1].matchAll(Q), (v) => v[1])); if (/;\s*$/.test(l)) { out.push({ location: alias.name, values: alias.values, line: alias.line, form: "alias" }); alias = null; } continue; }
      if (alias.values.length > 1) out.push({ location: alias.name, values: alias.values, line: alias.line, form: "alias" }); alias = null;
    }
    if ((m = /^\s*(?:export\s+)?interface\s+([A-Za-z_]\w*)/.exec(l))) { owner = m[1]; ownerIsAlias = false; arm = null; path.length = 0; depth = 0; }
    else if ((m = /^\s*(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l))) { owner = m[1]; ownerIsAlias = true; arm = null; path.length = 0; depth = 0; if (m[2].trim() === "" || m[2].trim() === "|") { alias = { name: m[1], line: i + 1, values: [] }; continue; } }
    // union arm opener: `| { type: "x"` / `| { kind: "x"` / `| (AgInputEnvelope & {` (+ discriminant on the next line)
    if (ownerIsAlias && depth === 0 && /^\s*\|\s*[({]/.test(l)) {
      const d = /(?:type|kind):\s*"([^"]+)"/.exec(l) ?? /^\s*(?:type|kind):\s*"([^"]+)"/.exec(stripTrailer(lines[i + 1] ?? ""));
      arm = d ? d[1] : null; path.length = 0; armDepth = depth;
    }
    // a union continued from the previous line: `| "c" | "d";` right after a line that recorded a union and did not end it
    if (!alias && /^\s*\|\s*"/.test(l) && out.length && out[out.length - 1].line === i && !/[;}]\s*$/.test(stripTrailer(lines[i - 1]))) {
      out[out.length - 1].values.push(...Array.from(l.matchAll(Q), (v) => v[1])); continue;
    }
    // a field whose union starts on the next line (`reason:` / `mode: "a" |` then `"b" | …`): the extractor does not join it — say so
    const nextT = (lines[i + 1] !== undefined ? stripTrailer(lines[i + 1]) : "").trim();
    const wrapsIntoUnion = (/:$/.test(t) && /^(?:"|\|\s*")/.test(nextT)) || (/\|$/.test(t) && !/^\s*(?:export\s+)?type\s+\w+\s*=\s*$/.test(l));
    if (!alias && !blockOwnerPending && t.length > 0 && !/^\/\//.test(t) && (wrapsIntoUnion || (/^"/.test(t) && !(out.length && out[out.length - 1].line === i)))) problems.push(`SPEC.md:${i + 1} a type line wraps (\`${t.slice(0, 40)}\`): a closed union split across lines is not read — keep each union on one line or as \`type X =\` alias lines`);
    // unions on this line — every `name?: "a" | "b"`, `name: ("a"|"b")[]`, `Array<"a"|"b">`, `type X = "a" | "b"`
    const re = /(?:\btype\s+)?\b([A-Za-z_]\w*)\??\s*[:=]\s*(?:\(|Array<)?\s*("[^"\n]+"(?:\s*\|\s*"[^"\n]+")+)/g;
    for (let mm = re.exec(l); mm; mm = re.exec(l)) {
      const values = Array.from(mm[2].matchAll(Q), (v) => v[1]);
      const tail = l.slice(mm.index + mm[0].length);
      if (/^\s*\|\s*"/.test(tail)) problems.push(`SPEC.md:${i + 1} union \`${mm[1]}\`: a quoted member after the consumed tail`);
      // nested one-liner: fields opened on this line before the match (`promptBlocked?: { reason: …`, `params: { mode: …`)
      const before = l.slice(0, mm.index); const inline = Array.from(before.matchAll(/([A-Za-z_]\w*)\??\s*:\s*(?:Array<)?\{/g), (x) => x[1]);
      const isAliasLine = /^\s*(?:export\s+)?type\s+\w+\s*=/.test(l) && mm[1] === owner;
      const location = isAliasLine ? owner : (() => { const saved = path.length; for (const n of inline) path.push({ name: n, depth }); const loc = locationOf(mm[1]); path.length = saved; return loc; })();
      out.push({ location, values, line: i + 1, form: isAliasLine ? "alias" : "field" });
    }
    // nesting: a field that opens a block and does not close it on the same line
    const delta = braceDelta(l);
    if (delta > 0) { const opener = /^\s*(?:\|\s*)?(?:\(\s*\w+\s*&\s*)?(?:([A-Za-z_]\w*)\??\s*:\s*(?:Array<)?)?\{/.exec(l) ?? /^\s*([A-Za-z_]\w*)\??\s*:\s*Array<\{/.exec(l); const name = opener?.[1]; for (let k = 0; k < delta; k++) path.push({ name: k === 0 ? name ?? null : null, depth: depth + k }); depth += delta; }
    else if (delta < 0) { depth += delta; while (path.length && path[path.length - 1].depth >= depth) path.pop(); if (arm !== null && depth <= armDepth) arm = null; }
  }
  return { unions: out, problems, otherFenceUnions };
}

/** Every `z.enum([...])` site in agjson.ts with its values: key forms `Export`, `Export.path.to.field`, `AgClosedEvent[arm].field`, `AgBlock[kind].field`. */
function extractSchemaEnumSitesWithValues(tsText) {
  const lines = tsText.split("\n"); const sites = []; let exportName = null, arm = null, armDepth = 0, pendingName = null;
  const path = []; let depth = 0;
  const valuesFrom = (i, at = 0, split = false) => { const from = (split ? lines[i].replace(/^\s*\./, "z.") + "\n" + lines.slice(i + 1).join("\n") : lines.slice(i).join("\n")); const k0 = split ? 0 : Math.max(0, at); const k = from.indexOf("z.enum(", k0) >= 0 ? from.indexOf("z.enum(", k0) : from.search(/z\s*\.\s*enum\(/); let d = 0, j = k + from.slice(k).search(/\(/), q = false; for (; j < from.length; j++) { const c = from[j]; if (c === '"') { q = !q; continue; } if (q) continue; if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") { d--; if (d === 0) break; } } return Array.from(from.slice(k, j + 1).matchAll(Q), (v) => v[1]); }; // quote-aware: a bracket inside a value ("[start,end]") never ends the slice
  const delta = (l) => { let d = 0, s = null; for (const ch of l) { if (s) { if (ch === s) s = null; continue; } if (ch === '"' || ch === "'" || ch === "`") s = ch; else if ("{([".includes(ch)) d++; else if ("})]".includes(ch)) d--; } return d; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/(?<!:)\/\/.*$/, ""); // colon-aware: a `://` inside a string is not a comment
    const ex = /^(?:export )?(?:const|type|interface|function) (\w+)/.exec(l); if (ex) { exportName = ex[1]; arm = null; armDepth = 0; path.length = 0; depth = 0; pendingName = null; }
    const disc = /type: z\.literal\("([a-z][a-z0-9.\-]*)"\)/.exec(l); if (disc && (exportName === "AgClosedEvent" || exportName === "AgBlock")) { arm = disc[1]; armDepth = depth; }
    // a chain-broken site: `field: z` on the previous line, `.enum([...])` on this one — keyed to the previous line's field
    const splitEnum = /^\s*\.enum\(/.test(l) && i > 0 && /\bz\s*$/.test(lines[i - 1].replace(/(?<!:)\/\/.*$/, ""));
    const enumLine = splitEnum ? lines[i - 1].replace(/(?<!:)\/\/.*$/, "") + " " + l.trim() : l;
    if (/z\s*\.\s*enum\(/.test(enumLine)) {
      const bare = /^(?:export )?const (\w+) = z\s*\.\s*enum\(/.exec(enumLine);
      const lead = /^\s*(\w+)\??:\s*/.exec(enumLine)?.[1] ?? null;
      const occurrences = bare ? [null] : Array.from(enumLine.matchAll(/(\w+):\s*(?:z\.array\()?z\s*\.\s*enum\(/g), (m) => ({ inner: m[1], at: m.index }));
      if (!bare && occurrences.length === 0) occurrences.push({ inner: null, at: enumLine.search(/z\s*\.\s*enum\(/) });
      for (const occ of occurrences) {
        let key;
        if (bare) key = bare[1];
        else {
          const inner = occ.inner; const segs = [...path.map((x) => x.name).filter(Boolean)];
          // `lead` is a nesting segment only when a `{` or `(` opens between it and this occurrence (`params: z.object({ mode: z.enum(…) })`);
          // a sibling field on the same line (`target: z.enum(…), action: z.enum(…)`) keys to its own name
          const nested = Boolean(lead && inner && lead !== inner && delta(enumLine.slice(enumLine.indexOf(lead + ":") + lead.length + 1, occ.at ?? 0)) > 0); // a block still OPEN at this occurrence (`params: z.object({ mode: …`), not one that opened and closed before it
          if (nested) segs.push(lead, inner); else if (inner) segs.push(inner); else if (pendingName) segs.push(pendingName);
          const p = segs.join("."); key = arm && (exportName === "AgClosedEvent" || exportName === "AgBlock") ? `${exportName}[${arm}].${p}` : `${exportName}.${p}`;
        }
        sites.push({ key, line: i + 1, values: valuesFrom(i, occ ? occ.at : 0, splitEnum) });
      }
    }
    const d = delta(l);
    if (/^\s*(\w+)\??:\s*z\s*$/.test(l)) pendingName = /^\s*(\w+)/.exec(l)[1];
    if (d > 0) { const name = /^\s*(\w+)\??:\s*/.exec(l)?.[1] ?? pendingName ?? null; for (let k = 0; k < d; k++) path.push({ name: k === 0 ? name : null, depth: depth + k }); depth += d; if (name) pendingName = null; }
    else if (d < 0) { depth += d; while (path.length && path[path.length - 1].depth >= depth) path.pop(); if (depth <= 0) pendingName = null; if (arm !== null && depth < armDepth) arm = null; }
  }
  return sites;
}

const norm = (s) => s.replace(/\[\]/g, "");
/** Locations a §12 row names: its `where` refs (schema locations) plus its `set` cell normalized to a location. */
function rowLocations(row, tsText) {
  const locs = new Set();
  for (const m of row.where.matchAll(/`([^`]+)`/g)) { const ref = m[1]; if (ref.startsWith("§")) continue; if (/^[a-z]/.test(ref) && !new RegExp(`^(?:export )?const ${ref.split(".")[0]}\\b`, "m").test(tsText)) continue; locs.add(norm(ref)); }
  const set = row.set.replace(/\*\*/g, "").trim();
  const parts = set.split(/\s*\/\s*/); // `AgMemoryRecord.scope` / `memory.write.scope`
  for (const part of parts) {
    const cell = part.replace(/\(.*$/, "").trim();
    const toks = Array.from(cell.matchAll(/`([^`]+)`|([A-Za-z_]\w*)/g), (x) => x[1] ?? x[2]).filter(Boolean);
    if (toks.length === 0) continue;
    let loc = toks.length === 1 ? toks[0] : toks.join(".");
    if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+\.\w+$/.test(loc) && loc.includes(".")) { const segs = loc.split("."); const field = segs.pop(); const ev = segs.join("."); if (/^[a-z]/.test(ev) && ev !== "annotations") loc = `AgClosedEvent[${ev}].${field}`; }
    if (/^[a-z][a-z-]*\.\w+$/.test(loc) && /-/.test(loc.split(".")[0])) loc = `AgBlock[${loc.split(".")[0]}].${loc.split(".")[1]}`; // code-result.outcome
    locs.add(norm(loc));
  }
  return locs;
}
function mapSpecLocation(loc) {
  let l = loc.replace(/^AgEvent\[/, "AgClosedEvent[");
  const inp = /^AgInput\[([^\]]+)\]\.(.*)$/.exec(l); if (inp && SPEC_LOCATION_MAP[`AgInput[${inp[1]}]`]) l = `${SPEC_LOCATION_MAP[`AgInput[${inp[1]}]`]}.${inp[2]}`;
  const cit = /^AgCitation\[[^\]]+\]\.(\w+)$/.exec(l); if (cit) l = `AgCitation.${cit[1]}`;
  if (SPEC_LOCATION_MAP[l]) l = SPEC_LOCATION_MAP[l];
  return l;
}
/** Bind a (mapped) location to rows by exact match only — a loose owner+field fallback would let a new closed set written
 *  under an already-named owner (or a schema site keyed under a nested path) pass as "named"; the few SPEC-side spellings the
 *  table does not carry are listed in SPEC_LOCATION_MAP instead. Returns { rows, rule }. */
function bindLocation(loc, rowsWithLocs) {
  const exact = rowsWithLocs.filter((r) => r.locs.has(loc));
  return exact.length ? { rows: exact, rule: "exact" } : { rows: [], rule: "none" };
}

function checkSpecUnionsAgainstSchema(specText, tsText) {
  const findings = [];
  const rows = extractSpecClosedSetTable(specText);
  const { unions, problems, otherFenceUnions } = extractSpecUnions(specText); findings.push(...problems.map((p) => `  ${p}`));
  const sites = extractSchemaEnumSitesWithValues(tsText);
  const rowsWithLocs = rows.map((r) => ({ row: r, locs: rowLocations(r, tsText) }));
  // sites → rows
  const siteRows = new Map(); for (const s of sites) { const b = bindLocation(mapSpecLocation(s.key), rowsWithLocs); siteRows.set(s, b); if (b.rows.length === 0) findings.push(`  agjson.ts:${s.line} closes \`${s.key}\` with z.enum but no §12 table row names that location (${b.rule})`); }
  const rowSites = new Map(); for (const [s, b] of siteRows) for (const r of b.rows) { if (!rowSites.has(r.row)) rowSites.set(r.row, []); rowSites.get(r.row).push(s); }
  // unions → rows → sites
  const pinned = new Map(); const receipt = [];
  for (const u of unions) {
    const mapped = mapSpecLocation(u.location); const b = bindLocation(mapped, rowsWithLocs);
    const entry = { line: u.line, location: u.location, mapped, rule: b.rule, rows: b.rows.map((r) => r.row.line), sites: [] };
    if (b.rows.length === 0) { findings.push(`  SPEC.md:${u.line} writes \`${u.location}\` as the closed union {${u.values.join(", ")}} but no §12 table row names that location (resolved as \`${mapped}\`; ${b.rule})`); receipt.push(entry); continue; }
    const want = [...u.values].sort().join("|");
    for (const r of b.rows) {
      if ((rowSites.get(r.row) ?? []).length === 0) findings.push(`  SPEC.md:${u.line} \`${u.location}\` binds §12 table line ${r.row.line} (${r.row.set}), but no z.enum site in agjson.ts is keyed to that row — the schema no longer closes the set, or the keyer no longer reaches its site`);
      if (tableClass(r.row.cls) === "OPEN STRING") findings.push(`  §12 table line ${r.row.line} classes ${r.row.set} OPEN STRING, but SPEC.md:${u.line} still writes \`${u.location}\` as the closed union {${u.values.join(", ")}}`);
      for (const s of rowSites.get(r.row) ?? []) {
        entry.sites.push(s.key); if (!pinned.has(s)) pinned.set(s, []); pinned.get(s).push(u.line);
        const have = [...s.values].sort().join("|");
        if (have !== want) findings.push(`  SPEC.md:${u.line} \`${u.location}\` {${u.values.join(", ")}} ≠ agjson.ts:${s.line} \`${s.key}\` {${s.values.join(", ")}} (§12 table line ${r.row.line}, ${r.row.set})`);
      }
    }
    receipt.push(entry);
  }
  // reverse: every site pinned or excepted
  const unpinned = sites.filter((s) => !pinned.has(s) && !UNPINNED_SITE_EXCEPTIONS[s.key]);
  const excepted = sites.filter((s) => !pinned.has(s) && UNPINNED_SITE_EXCEPTIONS[s.key]).map((s) => s.key);
  for (const s of unpinned) findings.push(`  agjson.ts:${s.line} \`${s.key}\` is compared against no SPEC closed union (no SPEC location bound to its §12 row writes the set; not on the exception list)`);
  // twins census
  const bySet = new Map(); for (const s of sites) { const k = [...s.values].sort().join("|"); if (!bySet.has(k)) bySet.set(k, []); bySet.get(k).push(s); }
  const twins = [...bySet.values()].filter((g) => g.length > 1).map((g) => { const rowsOf = g.map((s) => (siteRows.get(s).rows[0]?.row.line ?? "—")); return { sites: g.map((s) => `${s.key}@${s.line}`), rows: rowsOf, shared: new Set(rowsOf).size === 1 }; });
  return { findings, unions: unions.length, otherFenceUnions, sites: sites.length, pinned: sites.length - unpinned.length - excepted.length, unpinned: unpinned.map((s) => s.key), excepted, receipt, twins };
}

/**
 * Run the full drift check against the supplied sources. Returns
 * `{ findings, checked }`. `sources.spec` / `sources.ts` must be full file
 * contents; inlining the I/O lets `--self-test` swap in a mutated SPEC.
 */
function runCheck(sources) {
  const findings = [];

  const specEventTypes = extractSpecEventTypes(sources.spec);
  const schemaEventTypes = extractSchemaEventTypes(sources.ts);
  findings.push(...compareSets("AgEvent.type", specEventTypes, schemaEventTypes));

  const specInputKinds = extractSpecInputKinds(sources.spec);
  const schemaInputKinds = extractSchemaInputKinds(sources.ts);
  findings.push(...compareSets("AgInput.kind", specInputKinds, schemaInputKinds));

  // 4. AgUsage field set: interface == zod (both ways); interface ⊆ SPEC.
  const specUsage = extractUsageInterfaceFields(sources.spec, "SPEC.md");
  const tsUsage = extractUsageInterfaceFields(sources.ts, "agjson.ts");
  const zodUsage = extractUsageZodFields(sources.ts);
  findings.push(...compareSets("AgUsage", tsUsage, zodUsage, ["the agjson.ts interface", "its zod object"]));
  const undefinedInSpec = setMinus(tsUsage, specUsage);
  if (undefinedInSpec.length > 0) {
    findings.push(`  AgUsage: in agjson.ts but not defined in SPEC.md §4: ${undefinedInSpec.join(", ")}`);
  }
  const advisory = setMinus(specUsage, tsUsage);

  // 5. §12 closed-set table ↔ agjson.ts z.enum sites.
  const table = checkClosedSetTable(sources.spec, sources.ts);
  findings.push(...table.findings);

  // 6. SPEC closed unions ↔ z.enum sites through the §12 table; OPEN STRING rows bind no closed union; every site pinned.
  const unions = checkSpecUnionsAgainstSchema(sources.spec, sources.ts);
  findings.push(...unions.findings);

  return {
    findings,
    advisory,
    checked: {
      tableRows: table.rows,
      enumSites: table.sites,
      specUnions: unions.unions,
      otherFenceUnions: unions.otherFenceUnions,
      enumSites6: unions.sites,
      enumSitesPinned: unions.pinned,
      unpinnedSites: unions.unpinned,
      exceptedSites: unions.excepted,
      census: { receipt: unions.receipt, twins: unions.twins },
      specEventTypes: specEventTypes.length,
      schemaEventTypes: schemaEventTypes.length,
      specInputKinds: specInputKinds.length,
      schemaInputKinds: schemaInputKinds.length,
      specUsageFields: specUsage.length,
      schemaUsageFields: tsUsage.length,
    },
  };
}

async function loadRealSources() {
  const [spec, ts] = await Promise.all([
    readFile(specPath, "utf8"),
    readFile(agjsonPath, "utf8"),
  ]);
  // Comments are stripped once, up front, so both the positive run and the
  // --self-test mutation (below) operate on comment-free text.
  return { spec: stripComments(spec, { block: false }), ts: stripComments(ts) };
}

async function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");
  const census = args.includes("--census");

  const sources = await loadRealSources();

  const { findings, advisory, checked } = runCheck(sources);
  if (findings.length > 0) {
    console.error(`\n✖ SPEC ↔ agjson.ts wire-type drift detected (${findings.length} issue(s)):\n`);
    for (const line of findings) console.error(line);
    console.error(
      "\nFix: add/remove the literal or field on whichever side lags — SPEC.md §3/§4 or agjson.ts's AgClosedEvent/AgInput unions and its AgUsage interface + zod object.",
    );
    process.exit(1);
  }
  console.log(
    `✓ SPEC ↔ agjson.ts wire types in sync (${checked.specEventTypes} AgEvent.type literal(s), ${checked.specInputKinds} AgInput.kind literal(s), ${checked.schemaUsageFields} AgUsage field(s) checked); §12 closed-set table: ${checked.tableRows} row(s) ↔ ${checked.enumSites} z.enum site(s); SPEC unions: ${checked.specUnions} bound through the table, ${checked.enumSitesPinned} of ${checked.enumSites6} z.enum site(s) pinned — check 5 keys ${checked.enumSites}, this keyer also reaches AgCitationUnit, AgCitationBounds, AgRunConfig.toolChoice and AgMcpAppViewMessage.params.mode)`,
  );
  if (census) {
    console.log("\n§12-bound census (SPEC union → resolved location [rule] → row line(s) → compared z.enum site(s)):");
    for (const e of checked.census.receipt) console.log(`  SPEC.md:${String(e.line).padStart(4)}  ${e.location}  →  ${e.mapped}  [${e.rule}]  rows ${e.rows.join(",") || "—"}  sites ${e.sites.join(" ") || "—"}`);
    console.log("twin z.enum sites (one value set at ≥2 sites) and whether one row names them all:");
    for (const t of checked.census.twins) console.log(`  ${t.shared ? "shared" : "SPLIT "} row(s) ${[...new Set(t.rows)].join(",")}: ${t.sites.join("  ")}`);
    console.log("SPEC → schema location map (SPEC_LOCATION_MAP):");
    for (const [k, v] of Object.entries(SPEC_LOCATION_MAP)) console.log(`  ${k} → ${v}`);
    console.log(`bare-block owners (SPEC_BLOCK_OWNERS): ${Object.entries(SPEC_BLOCK_OWNERS).map(([k, v]) => `${JSON.stringify(k)} → ${v}`).join("; ")}`);
    console.log(`unpinned-site exceptions: ${Object.keys(UNPINNED_SITE_EXCEPTIONS).length === 0 ? "none" : Object.entries(UNPINNED_SITE_EXCEPTIONS).map(([k, v]) => `${k} (${v})`).join("; ")}`);
    console.log(`closed unions written in a non-ts fence (ignored by the check): ${checked.otherFenceUnions}`);
  }
  if (advisory.length > 0) {
    console.log(`  advisory: SPEC.md §4 defines AgUsage field(s) the reference does not carry yet: ${advisory.join(", ")}`);
  }

  if (selfTest) {
    // Negative pass — rename one real AgEvent arm's type literal in an
    // in-memory copy of SPEC.md and confirm the detector fires on BOTH the
    // injected phantom and the now-missing real literal.
    const mutated = {
      ts: sources.ts,
      spec: sources.spec.replace(
        /type:\s*"turn\.abort"/,
        'type: "turn.phantom-injected-by-self-test"',
      ),
    };
    if (mutated.spec === sources.spec) {
      console.error(
        '\n✖ --self-test: could not apply seed mutation (SPEC.md did not contain `type: "turn.abort"` inside the AgEvent union)',
      );
      process.exit(1);
    }
    const { findings: negFindings } = runCheck(mutated);
    const mentionsPhantom = negFindings.some((f) =>
      f.includes("turn.phantom-injected-by-self-test"),
    );
    const mentionsMissingReal = negFindings.some((f) => f.includes("turn.abort"));
    if (!mentionsPhantom || !mentionsMissingReal) {
      console.error("\n✖ --self-test: negative case did not surface the expected drift.");
      console.error("findings were:");
      for (const line of negFindings) console.error(line);
      process.exit(1);
    }
    console.log("\n✓ --self-test: negative case produced the expected drift:");
    for (const line of negFindings) console.log(line);

    // Negative pass 2 — rename one AgUsage interface member in an in-memory
    // copy of agjson.ts (the zod object untouched) and confirm the detector
    // reports the phantom on the interface/zod comparison AND as undefined
    // in SPEC.md.
    const mutatedTs = {
      spec: sources.spec,
      ts: sources.ts.replace(/(export interface AgUsage \{[^}]*?)\bcostUsd\?:/, "$1costPhantomInjectedBySelfTest?:"),
    };
    if (mutatedTs.ts === sources.ts) {
      console.error("\n✖ --self-test: could not apply the AgUsage seed mutation (agjson.ts had no `costUsd?:` inside `export interface AgUsage`)");
      process.exit(1);
    }
    const { findings: usageFindings } = runCheck(mutatedTs);
    const phantomVsZod = usageFindings.some((f) => f.includes("its zod object") && f.includes("costPhantomInjectedBySelfTest"));
    const phantomVsSpec = usageFindings.some((f) => f.includes("not defined in SPEC.md") && f.includes("costPhantomInjectedBySelfTest"));
    if (!phantomVsZod || !phantomVsSpec) {
      console.error("\n✖ --self-test: the AgUsage negative case did not surface the expected drift.");
      for (const line of usageFindings) console.error(line);
      process.exit(1);
    }
    console.log("\n✓ --self-test: AgUsage negative case produced the expected drift:");
    for (const line of usageFindings) console.log(line);

    // Negative pass 3 — the §12 closed-set table: (i) a phantom z.enum member
    // injected into agjson.ts's AgCapabilities must be reported as unnamed by
    // the table; (ii) a phantom reference injected into a table row's `where`
    // cell must be reported as unresolved.
    const mutatedEnum = {
      spec: sources.spec,
      ts: sources.ts.replace(/(export const AgCapabilities = z\.object\(\{)/, '$1\n  phantomSetInjectedBySelfTest: z.enum(["a", "b"]),'),
    };
    if (mutatedEnum.ts === sources.ts) {
      console.error("\n✖ --self-test: could not apply the §12 seed mutation (agjson.ts had no `export const AgCapabilities = z.object({`)");
      process.exit(1);
    }
    const { findings: tableFindings } = runCheck(mutatedEnum);
    const unnamedPhantom = tableFindings.some((f) => f.includes("phantomSetInjectedBySelfTest") && f.includes("no §12 table row"));
    const mutatedRow = {
      spec: sources.spec.replace(/(\| `AgRole` \| )(`AgRole` \(export\);)/, "$1`AgPhantomInjectedBySelfTest.kind`, $2"),
      ts: sources.ts,
    };
    if (mutatedRow.spec === sources.spec) {
      console.error("\n✖ --self-test: could not apply the §12 row mutation (SPEC.md had no `| `AgRole` | `AgRole` (export);` row)");
      process.exit(1);
    }
    const { findings: rowFindings } = runCheck(mutatedRow);
    const unresolvedPhantom = rowFindings.some((f) => f.includes("AgPhantomInjectedBySelfTest") && f.includes("does not resolve"));
    if (!unnamedPhantom || !unresolvedPhantom) {
      console.error("\n✖ --self-test: the §12 table negative cases did not surface the expected drift.");
      for (const line of [...tableFindings, ...rowFindings]) console.error(line);
      process.exit(1);
    }
    console.log("\n✓ --self-test: §12 table negative cases produced the expected drift:");
    for (const line of [...tableFindings, ...rowFindings]) console.log(line);

    // Negative pass 4 — check 6. (a) The live tree pins every z.enum site through the table with
    // no exception, and the union extractor reaches the whole population (a regression that loses
    // a fence, an arm line, a nested field or the multi-line alias unpins a site and fails here).
    if (checked.enumSitesPinned + checked.exceptedSites.length !== checked.enumSites6 || checked.unpinnedSites.length !== 0 || checked.specUnions !== EXPECTED_SPEC_UNIONS || checked.enumSites6 !== EXPECTED_ENUM_SITES) {
      console.error(`\n✖ --self-test: check 6 keys ${checked.enumSites6} z.enum site(s) (expected exactly ${EXPECTED_ENUM_SITES}) and pins ${checked.enumSitesPinned} of them (excepted: ${checked.exceptedSites.join(", ") || "none"}; unpinned: ${checked.unpinnedSites.join(", ") || "none"}) with ${checked.specUnions} SPEC union(s) (expected exactly ${EXPECTED_SPEC_UNIONS}) — a SPEC edit that adds or removes a closed union updates EXPECTED_SPEC_UNIONS, and a schema edit that adds or removes a z.enum site updates EXPECTED_ENUM_SITES, in the same commit`);
      process.exit(1);
    }
    // (b) Thirteen mutations that must each surface a finding, applied one at a time to in-memory copies —
    // they cover the extractor's forms (an interface field, an AgEvent arm line, the multi-line alias, a
    // hyphenated value), a value dropped so the SPEC set equals ANOTHER row's set (the pool trap), one of
    // two twin z.enum sites grown alone, an OPEN STRING field written back as a closed union, a union no
    // row names (the completeness rule) and an alias removed so its z.enum site goes unpinned (the reverse rule).
    const seeds = [
      { name: "interface field union grows (AgReasoningConfig.mode)", spec: (s) => s.replace('mode: "enabled" | "disabled"', 'mode: "enabled" | "disabled" | "phantom_injected_by_self_test"'), expect: (f) => f.includes("phantom_injected_by_self_test") && f.includes("≠ agjson.ts") },
      { name: "OPEN STRING field written as a closed union (AgReasoningConfig.effort)", spec: (s) => s.replace("effort?: string;", 'effort?: "minimal" | "low" | "medium" | "high";'), expect: (f) => f.includes("OPEN STRING") && f.includes("`AgReasoningConfig.effort`") && f.includes("closed union") },
      { name: "AgEvent arm-line union grows (tool.done outcome)", spec: (s) => s.replace(/(type: "tool\.done";[^\n]*?outcome\?: "ok"\|"error"\|"denied"\|"input_required")/, '$1|"phantom_arm"'), expect: (f) => f.includes("phantom_arm") && f.includes("`AgEvent[tool.done].outcome`") },
      { name: "multi-line alias grows (AgFinishReason)", spec: (s) => s.replace('| "other" | "unknown";', '| "other" | "unknown" | "phantom_alias";'), expect: (f) => f.includes("phantom_alias") && f.includes("`AgFinishReason`") },
      { name: "hyphenated value added (AgSurfaceEnvelope.surface)", spec: (s) => s.replace('surface: "a2ui" | "mcp-app" | "openai-app"', 'surface: "a2ui" | "mcp-app" | "openai-app" | "phantom-kebab"'), expect: (f) => f.includes("phantom-kebab") && f.includes("`AgSurfaceEnvelope.surface`") },
      { name: "a value dropped so the set equals another row's (AgMemoryRecord.scope loses thread)", spec: (s) => s.replace('scope: "agent" | "user" | "skill" | "thread";', 'scope: "agent" | "user" | "skill";'), expect: (f) => f.includes("`AgMemoryRecord.scope`") && f.includes("≠ agjson.ts") },
      { name: "one twin z.enum site grown alone (the second resumeBinding)", ts: (t) => { const needle = 'resumeBinding: z.enum(["id", "positional"])'; const k = t.lastIndexOf(needle); return k < 0 ? t : t.slice(0, k) + 'resumeBinding: z.enum(["id", "positional", "phantom_twin"])' + t.slice(k + needle.length); }, expect: (f) => f.includes("phantom_twin") && f.includes("`AgClosedEvent[hitl.ask].resumeBinding`") },
      { name: "a closed union no §12 row names (a phantom interface) → completeness", spec: (s) => s.replace("interface AgMemoryRecord {", 'interface AgPhantomInjectedBySelfTest { kind: "alpha" | "beta" }\ninterface AgMemoryRecord {'), expect: (f) => f.includes("`AgPhantomInjectedBySelfTest.kind`") && f.includes("no §12 table row names that location") },
      { name: "the AgFinishReason alias removed → its z.enum site unpinned (reverse direction)", spec: (s) => s.replace(/type AgFinishReason =\n(?:\s*\|[^\n]*\n)+/, ""), expect: (f) => f.includes("`AgFinishReason` is compared against no SPEC closed union") },
      { name: "a chain-broken z.enum (`z` then `.enum(` on the next line) keeps its key and is compared", ts: (t) => t.replace('mode: z.enum(["enabled", "disabled"])', 'mode: z\n    .enum(["enabled", "disabled", "phantom_split"])'), expect: (f) => f.includes("phantom_split") && f.includes("`AgReasoningConfig.mode`") },
      { name: "a closed union at a new location under an already-named owner → completeness, no loose binding", spec: (s) => s.replace('| { type: "memory.write"; scope: "agent"|"user"|"skill"|"thread";', '| { type: "memory.write"; scope: "agent"|"user"|"skill"|"thread"; previous?: { scope: "agent"|"user"|"skill"|"thread" };'), expect: (f) => f.includes("`AgEvent[memory.write].previous.scope`") && f.includes("no §12 table row names that location") },
      { name: "a field union wrapped onto the next line is reported, not dropped", spec: (s) => s.replace('promptBlocked?: { reason: "safety"|"blocklist"|"prohibited"|"other";', 'promptBlocked?: { reason:\n    "safety"|"blocklist"|"prohibited"|"other";'), expect: (f) => f.includes("a type line wraps") },
      { name: "a z.enum site opened to z.string while SPEC still closes the set → its row binds no site", ts: (t) => t.replace('z.enum(["summarized", "full"])', "z.string()"), expect: (f) => f.includes("no z.enum site in agjson.ts is keyed to that row") && f.includes("`AgEvent[reasoning.start].mode`") },
    ];
    const seedLines = [];
    for (const seed of seeds) {
      const mutated = { spec: seed.spec ? seed.spec(sources.spec) : sources.spec, ts: seed.ts ? seed.ts(sources.ts) : sources.ts };
      if (mutated.spec === sources.spec && mutated.ts === sources.ts) { console.error(`\n✖ --self-test: could not apply the check-6 seed "${seed.name}" (its anchor text is gone)`); process.exit(1); }
      const { findings: seedFindings } = runCheck(mutated);
      const hit = seedFindings.filter(seed.expect);
      if (hit.length === 0) { console.error(`\n✖ --self-test: the check-6 seed "${seed.name}" surfaced no matching finding.`); for (const line of seedFindings) console.error(line); process.exit(1); }
      seedLines.push(`  [${seed.name}]`, ...hit.map((l) => "  " + l));
    }
    // (c) A correct reclass must stay GREEN: a row moved to OPEN STRING with its SPEC line opened and its
    // z.enum removed produces no finding — the shared field name `kind` on other types must not false-red.
    const reclass = {
      spec: sources.spec
        .replace("| `AgTrigger.kind` | `AgTrigger.kind` (`AgClosedEvent[turn.start].trigger`, `AgTurnRecord.trigger`) | FROZEN |", "| `AgTrigger.kind` | `AgTrigger.kind` (`AgClosedEvent[turn.start].trigger`, `AgTurnRecord.trigger`) | OPEN STRING (documented values) |")
        .replace('kind: "user" | "resume" | "schedule" | "webhook" | "email" | "agent" | "cron" | "unknown";', "kind: string;"),
      ts: sources.ts.replace('kind: z.enum(["user", "resume", "schedule", "webhook", "email", "agent", "cron", "unknown"]),', "kind: z.string(),"),
    };
    if (reclass.spec === sources.spec || !reclass.spec.includes("OPEN STRING (documented values) | out | none (fallback") || reclass.ts === sources.ts) { console.error("\n✖ --self-test: could not apply the check-6 reclass control (one of its three anchors is gone)"); process.exit(1); }
    const { findings: reclassFindings } = runCheck(reclass);
    if (reclassFindings.length !== 0) { console.error("\n✖ --self-test: the check-6 reclass control (AgTrigger.kind → OPEN STRING on all three sides) must produce no finding:"); for (const line of reclassFindings) console.error(line); process.exit(1); }
    // (d) Two formattings that must stay GREEN: two z.enum sites on one line (each keyed to its own field, 40 sites), and a
    // non-union type line wrapped onto the next line (no wrap finding).
    const joined = { spec: sources.spec, ts: sources.ts.replace('    target: z.enum(["input", "output", "tool"]),\n    passed: z.boolean(),\n    action: z.enum(["block", "retry", "rewrite", "override", "terminate"]).optional(),', '    target: z.enum(["input", "output", "tool"]), action: z.enum(["block", "retry", "rewrite", "override", "terminate"]).optional(),\n    passed: z.boolean(),') };
    if (joined.ts === sources.ts) { console.error("\n✖ --self-test: could not apply the joined-line control (the guardrails block anchor is gone)"); process.exit(1); }
    const joinedRun = runCheck(joined);
    if (joinedRun.findings.length !== 0 || joinedRun.checked.enumSites6 !== EXPECTED_ENUM_SITES) { console.error(`\n✖ --self-test: two z.enum sites on one line must key to their own fields and stay green (${joinedRun.checked.enumSites6} sites):`); for (const line of joinedRun.findings) console.error(line); process.exit(1); }
    const wrapped = { ts: sources.ts, spec: sources.spec.replace("interface AgSurfaceEnvelope {", "interface AgSurfaceEnvelope {\n  wrappedProbe?:\n    string;") };
    if (wrapped.spec === sources.spec) { console.error("\n✖ --self-test: could not apply the non-union wrap control (no `interface AgSurfaceEnvelope {`)"); process.exit(1); }
    const wrappedRun = runCheck(wrapped);
    if (wrappedRun.findings.length !== 0) { console.error("\n✖ --self-test: a wrapped NON-union type line must produce no finding:"); for (const line of wrappedRun.findings) console.error(line); process.exit(1); }
    console.log(`\n✓ --self-test: check 6 — ${checked.enumSitesPinned}/${checked.enumSites6} z.enum site(s) pinned on the live tree; ${seeds.length} negative seeds produced the expected drift; the reclass, joined-line and non-union-wrap controls stayed green:`);
    for (const line of seedLines) console.log(line);
  }
}

main().catch((err) => {
  console.error(`✖ check-spec-drift crashed: ${err.stack || err.message}`);
  process.exit(1);
});
