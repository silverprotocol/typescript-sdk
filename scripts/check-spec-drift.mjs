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
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
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
  const armRef = /^(AgClosedEvent|AgBlock)\[([a-z][a-z0-9.\-]*)\]\.(\w+)$/.exec(ref);
  if (armRef) {
    const region = armRegion(tsText, armRef[2]);
    if (!region) return `no \`type: z.literal("${armRef[2]}")\` arm`;
    return new RegExp(`\\b${armRef[3]}\\s*:`).test(region) ? null : `arm ${armRef[2]} has no member \`${armRef[3]}\``;
  }
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

  return {
    findings,
    advisory,
    checked: {
      tableRows: table.rows,
      enumSites: table.sites,
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
  return { spec: stripComments(spec), ts: stripComments(ts) };
}

async function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");

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
    `✓ SPEC ↔ agjson.ts wire types in sync (${checked.specEventTypes} AgEvent.type literal(s), ${checked.specInputKinds} AgInput.kind literal(s), ${checked.schemaUsageFields} AgUsage field(s) checked); §12 closed-set table: ${checked.tableRows} row(s) ↔ ${checked.enumSites} z.enum site(s))`,
  );
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
  }
}

main().catch((err) => {
  console.error(`✖ check-spec-drift crashed: ${err.stack || err.message}`);
  process.exit(1);
});
