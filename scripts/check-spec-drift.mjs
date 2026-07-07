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

/**
 * Compare two literal sets both directions. Returns a list of finding lines
 * (empty = clean).
 */
function compareSets(label, specValues, schemaValues) {
  const findings = [];
  const missingFromSchema = setMinus(specValues, schemaValues);
  const missingFromSpec = setMinus(schemaValues, specValues);
  if (missingFromSchema.length > 0) {
    findings.push(
      `  ${label}: in SPEC.md but missing from agjson.ts: ${missingFromSchema.join(", ")}`,
    );
  }
  if (missingFromSpec.length > 0) {
    findings.push(
      `  ${label}: in agjson.ts but missing from SPEC.md: ${missingFromSpec.join(", ")}`,
    );
  }
  return findings;
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

  return {
    findings,
    checked: {
      specEventTypes: specEventTypes.length,
      schemaEventTypes: schemaEventTypes.length,
      specInputKinds: specInputKinds.length,
      schemaInputKinds: schemaInputKinds.length,
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

  const { findings, checked } = runCheck(sources);
  if (findings.length > 0) {
    console.error(`\n✖ SPEC ↔ agjson.ts wire-type drift detected (${findings.length} issue(s)):\n`);
    for (const line of findings) console.error(line);
    console.error(
      "\nFix: add/remove the literal on whichever side lags — SPEC.md §3/§4 or agjson.ts's AgClosedEvent/AgInput unions.",
    );
    process.exit(1);
  }
  console.log(
    `✓ SPEC ↔ agjson.ts wire types in sync (${checked.specEventTypes} AgEvent.type literal(s), ${checked.specInputKinds} AgInput.kind literal(s) checked)`,
  );

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
  }
}

main().catch((err) => {
  console.error(`✖ check-spec-drift crashed: ${err.stack || err.message}`);
  process.exit(1);
});
