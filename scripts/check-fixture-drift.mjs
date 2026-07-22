#!/usr/bin/env node
/**
 * Facet SDK-surface ratchet gate (playbook backlog Task 6 / audit MC-T3 lesson).
 *
 * MC-T3's lesson: the last SDK bump (claude-agent-sdk 0.2.141->0.3.199,
 * @openai/agents 0.2.1->0.12.0) shipped several new wire families that TS's
 * structural typing absorbed SILENTLY — the compiler stayed green while real
 * wire families went unhandled (see .superpowers/sdd/playbook-sdk-bumps-report.md).
 * Those were caught by careful reviewer reading, not mechanically. This gate
 * makes that check durable: it diffs each facet's ACTUAL installed SDK member
 * inventory against a per-facet ratchet manifest (`sdk-surface.json`) that
 * records an honest, human-adjudicated disposition for every member. A member
 * the SDK has but the manifest doesn't know about FAILS the gate BY NAME,
 * forcing a triage disposition before the bump can land quietly. A member the
 * manifest expects but the SDK no longer has ALSO fails (removal = breaking
 * drift). Style precedent: `scripts/check-spec-drift.mjs` (same repo — mirror
 * its `extractStatement` bracket-depth-tracked statement-slicing, `--self-test`
 * discipline, and exit-code conventions). Zero deps, pure Node.
 *
 * # What is compared, per facet
 *
 * **claude-agent-sdk** (`packages/claude-agent-sdk/sdk-surface.json`): the
 * `SDKMessage` union's arm TYPE NAMES, extracted from the single
 * `export declare type SDKMessage = A | B | …;` line of
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
 *
 * **openai-agents** (`packages/openai-agents/sdk-surface.json`): TWO separate
 * inventories from `@openai/agents-core`'s `.d.ts`, kept as separate manifest
 * sections so a rename in one is attributable without conflating it with drift
 * in the other:
 *   1. `runItemStreamEventName` — the `RunItemStreamEventName` string-literal
 *      union (`dist/events.d.ts`) — the `name` discriminant on every
 *      `run_item_stream_event`.
 *   2. `protocolItem` — the top-level `type:` discriminants of the `ModelItem`
 *      discriminated union (`dist/types/protocol.d.ts`) — the full
 *      bidirectional protocol-item vocabulary (a superset of `OutputModelItem`
 *      that also includes `computer_call_result`, relevant for input-history
 *      reconstruction).
 *
 * **google-adk** (`packages/google-adk/sdk-surface.json`): UNLIKE the other
 * two facets, this one does not import its upstream SDK at runtime — the
 * facet's `AdkEvent`/`AdkPart` are a HAND-TYPED PROJECTION of the verified
 * wire (`@google/adk` is an optional peerDependency, never imported). So the
 * inventory ratchets "does the INSTALLED reference SDKs' field vocabulary
 * still match what the hand-typed contract assumes", via TWO separate
 * sections, each resolved from a DIFFERENT npm package (kept separate for the
 * same attributability reason as openai-agents' two sections):
 *   1. `partKind` — the Gemini `Part` interface's own field names
 *      (`@google/genai`'s `dist/genai.d.ts`, `export declare interface Part`)
 *      — the part-kind vocabulary the facet's `driveAdkPart` switches on.
 *   2. `eventField` — the `Event`/`LlmResponse` interface field names (the
 *      OFFICIAL `@google/adk`'s `dist/types/events/event.d.ts` +
 *      `dist/types/models/llm_response.d.ts`; `Event extends LlmResponse`,
 *      both interfaces' own fields flattened into one inventory; retargeted
 *      2026-07-13 from `@iqai/adk`'s bundled class declarations).
 *
 * # Resolution
 *
 * All three facets' SDKs are resolved via `packages/e2e`'s EXACT devDependency
 * pins (the capture-agent leg — the same version the playbook's
 * drift/adaptation ritual itself diffs against), using `createRequire` scoped
 * to `packages/e2e` so resolution cannot escape into an unrelated outer
 * workspace's `node_modules` (verified hazard: a naive
 * `require.resolve(pkg, {paths:[…]})` walk from a package with no local hoist
 * for `pkg` can walk all the way past this repo's own `node_modules` root).
 * Two packages are TRANSITIVE (not a direct dependency of their facet package
 * or of `packages/e2e`), so each is resolved in a SECOND hop: `@openai/agents-
 * core` via `@openai/agents` (a direct `packages/e2e` devDependency) scoped to
 * agents' own installed directory; `@google/genai` via `@google/adk` (also a
 * direct `packages/e2e` devDependency) scoped to adk's own installed
 * directory — both hops stay local (the sibling in the same pnpm store
 * subtree) and never escape.
 *
 * If a facet's SDK package cannot be resolved (not installed — e.g. a
 * standalone open-source clone before `pnpm --filter e2e install`), that
 * facet's check is SKIPPED gracefully (a message, no failure) rather than
 * erroring — the gate only enforces drift on facets it can actually verify.
 * For google-adk, resolution of EITHER `@google/adk` or (via its second hop)
 * `@google/genai` failing skips BOTH of the facet's sections together (one
 * unit, mirroring how an openai-agents resolution failure skips both of ITS
 * sections).
 *
 * # Usage
 *
 *   node scripts/check-fixture-drift.mjs              # verify repo state
 *   node scripts/check-fixture-drift.mjs --self-test   # + negative-case proof
 *
 * `--self-test` re-runs the comparison against an in-memory-mutated copy of
 * each resolvable facet's REAL extracted inventory (one fake member injected,
 * one real manifest-known member removed) and asserts the checker reports
 * BOTH the injected phantom member and the now-missing real one. If NO facet
 * is resolvable in the current environment, a synthetic in-memory fixture
 * proves the comparator can still fail, so `--self-test` is never vacuously
 * green. This proves the detector can actually fail (M58's lesson — a gate
 * that cannot fail is a defect — applied to this gate too).
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { checkCompatStaleness } from "./render-compat.mjs";

const scriptDir = import.meta.dirname;
// scripts/ -> typescript/ (this manifest pair + the two facet packages all
// live under sdks/typescript, unlike check-spec-drift.mjs's SPEC.md which
// lives one level further up at the repo root).
const typescriptRoot = resolve(scriptDir, "..");
const e2eDir = resolve(typescriptRoot, "packages", "e2e");
const e2ePackageJson = resolve(e2eDir, "package.json");

const VALID_DISPOSITIONS = new Set([
  "handled",
  "carried",
  "router-plane",
  "not-applicable",
  "silently-dropped",
]);

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

/**
 * Slice a `name STARTMARKER … ;` top-level statement out of `src`, starting at
 * the first occurrence of `startMarker`. Tracks `{`, `(`, `[` depth so
 * semicolons nested inside object/array literals don't false-terminate the
 * scan; returns the substring up to and including the first `;` seen at depth
 * 0. Returns null if `startMarker` or a terminating top-level `;` isn't found.
 * (Mirrors `check-spec-drift.mjs`'s helper of the same name exactly.)
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
 * Walk up from `requireFn.resolve(packageName)`'s resolved entry file until a
 * `package.json` whose own `name` field matches `packageName` is found. This
 * is the standard "find the package root" algorithm — needed because modern
 * packages' `exports` maps forbid resolving `<pkg>/package.json` directly
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and the resolved main-entry file is often
 * nested (e.g. `dist/index.js`), not a direct child of the package root.
 */
function resolvePackageRoot(requireFn, packageName) {
  const entryPath = requireFn.resolve(packageName);
  let dir = dirname(entryPath);
  for (;;) {
    const pkgJsonPath = resolve(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.name === packageName) return { dir, version: pkg.version };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the package root for "${packageName}" above ${entryPath}`);
    }
    dir = parent;
  }
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
 * Extract the `SDKMessage` union's arm TYPE NAMES from a claude-agent-sdk
 * `sdk.d.ts` full text: `export declare type SDKMessage = A | B | …;` is a
 * single flat union of type-alias names (no nested braces), so a plain
 * `|`-split of the statement body (after slicing the statement out with
 * `extractStatement`, which tracks bracket depth for the terminating `;`)
 * suffices.
 */
function extractClaudeSdkMessageArms(sdkDtsText) {
  const marker = "export declare type SDKMessage =";
  const stmt = extractStatement(sdkDtsText, marker);
  if (stmt == null) {
    throw new Error("sdk.d.ts: `export declare type SDKMessage = …;` union not found");
  }
  const body = stmt.slice(marker.length, -1); // drop the marker prefix + trailing `;`
  return body
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Extract the `RunItemStreamEventName` string-literal union members from an
 * `@openai/agents-core` `dist/events.d.ts` full text:
 * `export type RunItemStreamEventName = 'a' | 'b' | …;`.
 */
function extractOpenaiRunItemStreamEventNames(eventsDtsText) {
  const marker = "export type RunItemStreamEventName =";
  const stmt = extractStatement(eventsDtsText, marker);
  if (stmt == null) {
    throw new Error("events.d.ts: `RunItemStreamEventName` union not found");
  }
  const body = stmt.slice(marker.length, -1);
  const re = /'([a-zA-Z_][a-zA-Z0-9_]*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Given the full text of a `z.ZodDiscriminatedUnion<[ARM1, ARM2, …], "type">`
 * (or `z.ZodUnion<readonly [...]>`) TS-compiled zod `.d.ts` statement, extract
 * each top-level ARM's own `type:` literal — i.e. the arm's discriminant, NOT
 * any `type:` literal nested deeper inside a content/action/output sub-union.
 *
 * Each arm is `z.ZodObject<{ … }, z.core.$strip>` (or `$loose`); this scans
 * for every `z.ZodObject<{` occurrence, tracks `{`/`}` depth from there to
 * find that SPECIFIC arm's matching close, then looks for the FIRST
 * `type: z.ZodLiteral<"…">` (or the optional-wrapped
 * `type: z.ZodOptional<z.ZodLiteral<"…">>` form used by role-tagged message
 * arms) inside that slice. Because every arm in this SDK's protocol schema
 * declares its own discriminant early (right after `providerData`/`id`,
 * before any nested content array reopens `{`/`[` depth), the FIRST match
 * within an arm's own bounds is reliably that arm's discriminant, not a
 * nested one — verified empirically against every arm of `ModelItem` (see
 * `.superpowers/sdd/pb-task-6-report.md`). After processing an arm, the
 * search resumes AFTER its closing brace, so nested `z.ZodObject<{` matches
 * inside content/action sub-unions are skipped entirely, never miscounted as
 * top-level arms.
 */
function extractUnionArmTypeLiterals(statementText) {
  const armStartRe = /z\.ZodObject<\{/g;
  const results = [];
  let m;
  while ((m = armStartRe.exec(statementText)) !== null) {
    const start = m.index + m[0].length - 1; // position of the arm's opening `{`
    let depth = 0;
    let end = -1;
    for (let i = start; i < statementText.length; i++) {
      const ch = statementText[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue; // malformed/truncated input; skip defensively
    const armBody = statementText.slice(start, end + 1);
    const typeMatch = /type:\s*z\.Zod(?:Optional<z\.Zod)?Literal<"([a-zA-Z][a-zA-Z0-9_]*)">/.exec(armBody);
    if (typeMatch) results.push(typeMatch[1]);
    armStartRe.lastIndex = end;
  }
  return [...new Set(results)];
}

/**
 * Extract the `ModelItem` discriminated union's top-level protocol-item
 * `type:` discriminants from an `@openai/agents-core` `dist/types/protocol.d.ts`
 * full text.
 */
function extractOpenaiModelItemTypes(protocolDtsText) {
  const marker = "export declare const ModelItem: z.ZodUnion<readonly [";
  const stmt = extractStatement(protocolDtsText, marker);
  if (stmt == null) {
    throw new Error("protocol.d.ts: `ModelItem` union not found");
  }
  return extractUnionArmTypeLiterals(stmt);
}

/**
 * Slice the BODY (excluding the outer braces) of a `headerMarker … { … }`
 * brace block out of `src` — used for google-adk's `declare class`/
 * `declare interface` bodies (a shape `extractStatement` doesn't fit: those
 * end at a matching `}`, not a top-level `;`). `headerMarker` MUST end with
 * the block's own opening `{` (e.g. `"declare class LlmResponse {"`); depth
 * tracking starts AT that `{` so it is depth 1, and the scan returns the
 * slice up to (excluding) the `}` that first brings depth back to 0.
 */
function extractBraceBlockBody(src, headerMarker) {
  if (!headerMarker.endsWith("{")) {
    throw new Error(`extractBraceBlockBody: headerMarker must end with "{": ${headerMarker}`);
  }
  const start = src.indexOf(headerMarker);
  if (start === -1) return null;
  const braceStart = start + headerMarker.length - 1; // index of the marker's own trailing "{"
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart + 1, i);
    }
  }
  return null;
}

/** Strip `/* … *\/` block comments (this helper's only caller feeds it bundled
 *  `.d.ts` class/interface bodies, which use JSDoc `/**…*\/` comments — never
 *  `//` line comments — so only block-comment stripping is needed here). */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Split `body` into top-level (`{`/`(`/`[`-depth-tracked) `;`-terminated
 * statements, discarding the trailing empty tail after the last `;`.
 */
function splitTopLevelStatements(body) {
  const out = [];
  let depth = 0;
  let stmtStart = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) {
      out.push(body.slice(stmtStart, i));
      stmtStart = i + 1;
    }
  }
  return out;
}

// A field declaration's name is followed IMMEDIATELY (modulo an optional
// `?`) by `:` (e.g. `text?: string`). A METHOD's name is instead followed by
// `(` (`isFinalResponse(): boolean`), and a modifier-prefixed member
// (`private`/`protected`/`static`/`readonly`/`constructor`/`get`/`set`) never
// matches at all, because the modifier word itself is followed by a SPACE,
// not `?`/`:` — so methods, accessors, and modified members are excluded
// structurally, with no separate keyword-denylist needed.
const FIELD_DECL_RE = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\??\s*:/;

/**
 * Extract top-level DATA FIELD names (never method names) declared directly
 * inside a `declare class X { … }` / `declare interface X { … }` body text
 * (comments already assumed present — this function strips them itself).
 */
function extractFieldNames(bodyText) {
  const stripped = stripBlockComments(bodyText);
  const names = [];
  for (const raw of splitTopLevelStatements(stripped)) {
    const stmt = raw.trim();
    if (stmt.length === 0) continue;
    const m = FIELD_DECL_RE.exec(stmt);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

/**
 * Extract the Gemini `Part` interface's own field names from an
 * `@google/genai` `dist/genai.d.ts` full text
 * (`export declare interface Part { … }`).
 */
function extractGenaiPartFields(genaiDtsText) {
  const marker = "export declare interface Part {";
  const body = extractBraceBlockBody(genaiDtsText, marker);
  if (body == null) {
    throw new Error("genai.d.ts: `export declare interface Part { … }` not found");
  }
  return extractFieldNames(body);
}

/**
 * Extract the `Event`/`LlmResponse` interface field names from the OFFICIAL
 * `@google/adk` multi-file typings (`dist/types/models/llm_response.d.ts` +
 * `dist/types/events/event.d.ts`). `Event extends LlmResponse`; both
 * interfaces' OWN fields are flattened into one Set — matching how the
 * hand-typed `AdkEvent` contract itself makes no Event/LlmResponse split.
 * (Pre-retarget this parsed `@iqai/adk`'s single bundled `dist/index.d.ts`,
 * where both were `declare class` — the official SDK ships interfaces split
 * across per-module files instead.)
 */
function extractAdkEventFields(llmResponseDtsText, eventDtsText) {
  const llmResponseMarker = "export interface LlmResponse {";
  const eventMarker = "export interface Event extends LlmResponse {";
  const llmResponseBody = extractBraceBlockBody(llmResponseDtsText, llmResponseMarker);
  if (llmResponseBody == null) {
    throw new Error("models/llm_response.d.ts: `export interface LlmResponse { … }` not found");
  }
  const eventBody = extractBraceBlockBody(eventDtsText, eventMarker);
  if (eventBody == null) {
    throw new Error("events/event.d.ts: `export interface Event extends LlmResponse { … }` not found");
  }
  return [...new Set([...extractFieldNames(llmResponseBody), ...extractFieldNames(eventBody)])];
}

// -----------------------------------------------------------------------------
// SDK resolution (graceful skip when not installed)
// -----------------------------------------------------------------------------

class SdkNotInstalled extends Error {}

/** Resolve claude-agent-sdk's `sdk.d.ts` via packages/e2e's exact devDependency pin. */
async function resolveClaudeSdk() {
  let pkg;
  try {
    const requireFromE2e = createRequire(e2ePackageJson);
    pkg = resolvePackageRoot(requireFromE2e, "@anthropic-ai/claude-agent-sdk");
  } catch (err) {
    throw new SdkNotInstalled(String(err instanceof Error ? err.message : err));
  }
  const dtsPath = resolve(pkg.dir, "sdk.d.ts");
  if (!existsSync(dtsPath)) {
    throw new SdkNotInstalled(`sdk.d.ts not found under resolved package root ${pkg.dir}`);
  }
  const dts = await readFile(dtsPath, "utf8");
  return { version: pkg.version, dts };
}

/**
 * Resolve `@openai/agents-core`'s `events.d.ts` + `protocol.d.ts` via
 * packages/e2e's exact `@openai/agents` devDependency pin, then a second hop
 * to its own (transitive) `@openai/agents-core` dependency.
 */
async function resolveOpenaiSdk() {
  let pkg;
  let agentsVersion;
  try {
    const requireFromE2e = createRequire(e2ePackageJson);
    // The umbrella package's OWN version — the version the `verified` log
    // records (no agents-core version-lockstep assumption needed).
    agentsVersion = resolvePackageRoot(requireFromE2e, "@openai/agents").version;
    const agentsEntry = requireFromE2e.resolve("@openai/agents");
    const requireFromAgents = createRequire(agentsEntry);
    pkg = resolvePackageRoot(requireFromAgents, "@openai/agents-core");
  } catch (err) {
    throw new SdkNotInstalled(String(err instanceof Error ? err.message : err));
  }
  const eventsDtsPath = resolve(pkg.dir, "dist", "events.d.ts");
  const protocolDtsPath = resolve(pkg.dir, "dist", "types", "protocol.d.ts");
  if (!existsSync(eventsDtsPath) || !existsSync(protocolDtsPath)) {
    throw new SdkNotInstalled(`events.d.ts / types/protocol.d.ts not found under resolved package root ${pkg.dir}`);
  }
  const [eventsDts, protocolDts] = await Promise.all([
    readFile(eventsDtsPath, "utf8"),
    readFile(protocolDtsPath, "utf8"),
  ]);
  return { version: pkg.version, agentsVersion, eventsDts, protocolDts };
}

/**
 * Resolve BOTH google-adk ground truths: the OFFICIAL `@google/adk`'s
 * `dist/types/models/llm_response.d.ts` + `dist/types/events/event.d.ts` via
 * packages/e2e's exact devDependency pin, and `@google/genai`'s
 * `dist/genai.d.ts` via a second hop scoped to `@google/adk`'s own installed
 * directory (transitive — `@google/genai` is not a direct dependency of the
 * google-adk facet package; mirrors `resolveOpenaiSdk`'s agents ->
 * agents-core hop, and keeps the part-kind vocabulary pinned to the EXACT
 * genai the installed adk itself resolves). Both are required for the
 * facet's TWO manifest sections, so either one failing to resolve throws
 * `SdkNotInstalled` for the whole facet (both sections skip together).
 * (Pre-retarget both hops went through `@iqai/adk`.)
 */
async function resolveGoogleAdkSdks() {
  let adkPkg;
  try {
    const requireFromE2e = createRequire(e2ePackageJson);
    adkPkg = resolvePackageRoot(requireFromE2e, "@google/adk");
  } catch (err) {
    throw new SdkNotInstalled(String(err instanceof Error ? err.message : err));
  }
  const llmResponseDtsPath = resolve(adkPkg.dir, "dist", "types", "models", "llm_response.d.ts");
  const eventDtsPath = resolve(adkPkg.dir, "dist", "types", "events", "event.d.ts");
  if (!existsSync(llmResponseDtsPath) || !existsSync(eventDtsPath)) {
    throw new SdkNotInstalled(
      `dist/types/models/llm_response.d.ts / dist/types/events/event.d.ts not found under resolved package root ${adkPkg.dir}`,
    );
  }

  let genaiPkg;
  try {
    const requireFromE2e = createRequire(e2ePackageJson);
    const adkEntry = requireFromE2e.resolve("@google/adk");
    const requireFromAdk = createRequire(adkEntry);
    genaiPkg = resolvePackageRoot(requireFromAdk, "@google/genai");
  } catch (err) {
    throw new SdkNotInstalled(String(err instanceof Error ? err.message : err));
  }
  const genaiDtsPath = resolve(genaiPkg.dir, "dist", "genai.d.ts");
  if (!existsSync(genaiDtsPath)) {
    throw new SdkNotInstalled(`dist/genai.d.ts not found under resolved package root ${genaiPkg.dir}`);
  }

  const [llmResponseDts, eventDts, genaiDts] = await Promise.all([
    readFile(llmResponseDtsPath, "utf8"),
    readFile(eventDtsPath, "utf8"),
    readFile(genaiDtsPath, "utf8"),
  ]);
  return { adkVersion: adkPkg.version, llmResponseDts, eventDts, genaiVersion: genaiPkg.version, genaiDts };
}

// -----------------------------------------------------------------------------
// Manifest loading + comparison
// -----------------------------------------------------------------------------

async function loadManifest(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

/** Validate every manifest entry has a recognised `disposition`. */
function validateManifestMembers(label, membersObj) {
  const findings = [];
  for (const [name, entry] of Object.entries(membersObj)) {
    if (entry == null || typeof entry !== "object" || typeof entry.disposition !== "string") {
      findings.push(`  ${label}: manifest entry "${name}" is malformed — expected { disposition, note }`);
      continue;
    }
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      findings.push(
        `  ${label}: manifest entry "${name}" has an unrecognised disposition "${entry.disposition}" (expected one of ${[...VALID_DISPOSITIONS].join(", ")})`,
      );
    }
  }
  return findings;
}

/**
 * Compare an installed member-name inventory against a manifest's `members`
 * map. Returns a list of finding lines (empty = clean). An installed member
 * absent from the manifest FAILS (forces a triage disposition — the M-C-T3
 * lesson). A manifest member absent from the installed inventory ALSO FAILS
 * (the SDK removed/renamed something the manifest still expects — breaking
 * drift).
 */
function compareMembers(label, installedMembers, manifestMembers) {
  const findings = [];
  const manifestNames = Object.keys(manifestMembers);

  const unknownToManifest = setMinus(installedMembers, manifestNames);
  const goneFromSdk = setMinus(manifestNames, installedMembers);

  if (unknownToManifest.length > 0) {
    findings.push(
      `  ${label}: on the SDK but MISSING a disposition in the manifest (new/unhandled member — triage required): ${unknownToManifest.join(", ")}`,
    );
  }
  if (goneFromSdk.length > 0) {
    findings.push(
      `  ${label}: in the manifest but REMOVED from the installed SDK (breaking drift — update the manifest): ${goneFromSdk.join(", ")}`,
    );
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Per-facet inventory assembly
// -----------------------------------------------------------------------------

/**
 * Build the list of `{ label, installed, manifestMembers }` inventories for
 * every RESOLVABLE facet, plus a list of skip messages for facets whose SDK
 * package could not be resolved. Shared by the real run and `--self-test`
 * (which needs the REAL extracted inventories to mutate in-memory).
 */
async function gatherInventories() {
  const inventories = [];
  const skips = [];
  const verifiedChecks = [];

  const claudeManifestPath = resolve(typescriptRoot, "packages", "claude-agent-sdk", "sdk-surface.json");
  try {
    const [manifest, sdk] = await Promise.all([loadManifest(claudeManifestPath), resolveClaudeSdk()]);
    verifiedChecks.push({
      facet: "claude-agent-sdk",
      sdkName: "@anthropic-ai/claude-agent-sdk",
      installedVersion: sdk.version,
      manifestVerifiedAt: manifest.verifiedAt,
      verifiedLog: manifest.verified,
    });
    inventories.push({
      facet: "claude",
      label: `claude SDKMessage union (installed ${sdk.version}, manifest verifiedAt ${manifest.verifiedAt})`,
      installed: extractClaudeSdkMessageArms(sdk.dts),
      manifestMembers: manifest.members,
      manifestValidationLabel: "claude sdk-surface.json",
    });
  } catch (err) {
    if (err instanceof SdkNotInstalled) {
      skips.push(`claude-agent-sdk: SKIPPED (SDK not resolvable) — ${err.message}`);
    } else {
      throw err;
    }
  }

  const openaiManifestPath = resolve(typescriptRoot, "packages", "openai-agents", "sdk-surface.json");
  try {
    const [manifest, sdk] = await Promise.all([loadManifest(openaiManifestPath), resolveOpenaiSdk()]);
    verifiedChecks.push({
      facet: "openai-agents",
      sdkName: "@openai/agents",
      // The umbrella package's own resolved version — NOT agents-core's (no
      // lockstep assumption; review finding on the earlier stand-in).
      installedVersion: sdk.agentsVersion,
      manifestVerifiedAt: manifest.verifiedAt,
      verifiedLog: manifest.verified,
    });
    inventories.push({
      facet: "openai",
      label: `openai RunItemStreamEventName (installed @openai/agents-core ${sdk.version}, manifest verifiedAt ${manifest.verifiedAt})`,
      installed: extractOpenaiRunItemStreamEventNames(sdk.eventsDts),
      manifestMembers: manifest.sections.runItemStreamEventName.members,
      manifestValidationLabel: "openai sdk-surface.json (runItemStreamEventName)",
    });
    inventories.push({
      facet: "openai",
      label: `openai ModelItem protocol-item type (installed @openai/agents-core ${sdk.version}, manifest verifiedAt ${manifest.verifiedAt})`,
      installed: extractOpenaiModelItemTypes(sdk.protocolDts),
      manifestMembers: manifest.sections.protocolItem.members,
      manifestValidationLabel: "openai sdk-surface.json (protocolItem)",
    });
  } catch (err) {
    if (err instanceof SdkNotInstalled) {
      skips.push(`openai-agents: SKIPPED (SDK not resolvable) — ${err.message}`);
    } else {
      throw err;
    }
  }

  const googleAdkManifestPath = resolve(typescriptRoot, "packages", "google-adk", "sdk-surface.json");
  try {
    const [manifest, sdk] = await Promise.all([loadManifest(googleAdkManifestPath), resolveGoogleAdkSdks()]);
    verifiedChecks.push({
      facet: "google-adk",
      sdkName: "@google/adk",
      installedVersion: sdk.adkVersion,
      // The section tracking the SAME SDK as the `verified` log (partKind
      // tracks @google/genai — deliberately not this).
      manifestVerifiedAt: manifest.sections.eventField.verifiedAt,
      verifiedLog: manifest.verified,
    });
    inventories.push({
      facet: "google-adk",
      label: `google-adk Part kind (installed @google/genai ${sdk.genaiVersion}, manifest verifiedAt ${manifest.sections.partKind.verifiedAt})`,
      installed: extractGenaiPartFields(sdk.genaiDts),
      manifestMembers: manifest.sections.partKind.members,
      manifestValidationLabel: "google-adk sdk-surface.json (partKind)",
    });
    inventories.push({
      facet: "google-adk",
      label: `google-adk Event/LlmResponse field (installed @google/adk ${sdk.adkVersion}, manifest verifiedAt ${manifest.sections.eventField.verifiedAt})`,
      installed: extractAdkEventFields(sdk.llmResponseDts, sdk.eventDts),
      manifestMembers: manifest.sections.eventField.members,
      manifestValidationLabel: "google-adk sdk-surface.json (eventField)",
    });
  } catch (err) {
    if (err instanceof SdkNotInstalled) {
      skips.push(`google-adk: SKIPPED (SDK not resolvable) — ${err.message}`);
    } else {
      throw err;
    }
  }

  return { inventories, skips, verifiedChecks };
}

// -----------------------------------------------------------------------------
// `verified` log consistency (the compatibility map's honesty check)
// -----------------------------------------------------------------------------

/**
 * Assert each facet's sdk-surface.json `verified` log (the append-only
 * compatibility evidence rendered into README tables by render-compat.mjs)
 * is current: its NEWEST entry must record the exact SDK version installed
 * via packages/e2e's pin. A mismatch means the pin moved without the
 * verification ritual (drift gate + fixtures ± live capture) being recorded
 * — the log would silently understate or overstate compatibility. A facet
 * with NO `verified` log yet is skipped (adoption is per-facet).
 */
function checkVerifiedLogs(verifiedChecks) {
  const findings = [];
  for (const check of verifiedChecks) {
    if (!Array.isArray(check.verifiedLog) || check.verifiedLog.length === 0) continue;
    const newest = check.verifiedLog[check.verifiedLog.length - 1];
    if (newest.sdkVersion !== check.installedVersion) {
      findings.push(
        `  ${check.facet}: installed ${check.sdkName} ${check.installedVersion} but sdk-surface.json's newest ` +
          `\`verified\` entry records ${newest.sdkVersion} — run the verification ritual against ` +
          `${check.installedVersion} and APPEND a \`verified\` entry (then \`node scripts/render-compat.mjs\`).`,
      );
    }
    // `verifiedAt` (the label field) tracks the same SDK — keep it in
    // lockstep with the log so the two can never tell different stories
    // (review finding: this diff itself had to hand-bump one).
    if (check.manifestVerifiedAt !== undefined && check.manifestVerifiedAt !== newest.sdkVersion) {
      findings.push(
        `  ${check.facet}: sdk-surface.json's \`verifiedAt\` (${check.manifestVerifiedAt}) disagrees with its newest ` +
          `\`verified\` entry (${newest.sdkVersion}) — update \`verifiedAt\` when appending the entry.`,
      );
    }
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Self-test (negative-case proof)
// -----------------------------------------------------------------------------

const PHANTOM_MEMBER = "PhantomMemberInjectedBySelfTest";

/**
 * Run the injected-phantom + removed-real-member negative case against one
 * inventory. Returns the finding lines (must be non-empty on both counts for
 * the self-test to pass).
 */
function selfTestOneInventory(inventory) {
  const manifestNames = Object.keys(inventory.manifestMembers);
  if (manifestNames.length === 0) {
    throw new Error(`self-test: "${inventory.label}" has an empty manifest — cannot pick a member to remove`);
  }
  const removedName = [...manifestNames].sort()[0];

  const mutatedInstalled = [...inventory.installed, PHANTOM_MEMBER].filter((m) => m !== removedName);
  return compareMembers(inventory.label, mutatedInstalled, inventory.manifestMembers);
}

/** Synthetic fallback so `--self-test` still proves something when no real facet is installed. */
function selfTestSynthetic() {
  const manifestMembers = { real_member: { disposition: "handled", note: "synthetic self-test fixture" } };
  const installed = [PHANTOM_MEMBER]; // "real_member" deliberately absent -> gone-from-SDK finding
  return compareMembers("synthetic fixture (no facet SDK resolvable in this environment)", installed, manifestMembers);
}

function runSelfTest(inventories, verifiedChecks) {
  const allFindings = inventories.length > 0 ? inventories.flatMap(selfTestOneInventory) : selfTestSynthetic();

  // Negative case for the verified-log class too (same doctrine: a gate that
  // cannot fail is a defect). Mutate IN-MEMORY COPIES only: a phantom
  // installed version must trip the newest-entry check, and a phantom
  // `verifiedAt` must trip the lockstep check.
  for (const check of verifiedChecks.filter((c) => Array.isArray(c.verifiedLog) && c.verifiedLog.length > 0)) {
    allFindings.push(
      ...checkVerifiedLogs([{ ...check, installedVersion: `999.999.999-${PHANTOM_MEMBER}` }]),
      ...checkVerifiedLogs([{ ...check, manifestVerifiedAt: `999.999.999-${PHANTOM_MEMBER}` }]),
    );
  }
  const verifiedNegativesExpected = verifiedChecks.some(
    (c) => Array.isArray(c.verifiedLog) && c.verifiedLog.length > 0,
  );
  const mentionsVerifiedLog = allFindings.some((f) => f.includes("`verified` entry"));
  const mentionsVerifiedAt = allFindings.some((f) => f.includes("`verifiedAt`"));

  const mentionsPhantom = allFindings.some((f) => f.includes(PHANTOM_MEMBER));
  const mentionsRemoval = allFindings.some((f) => f.includes("REMOVED from the installed SDK"));
  if (!mentionsPhantom || !mentionsRemoval || (verifiedNegativesExpected && (!mentionsVerifiedLog || !mentionsVerifiedAt))) {
    console.error("\n✖ --self-test: negative case did not surface the expected drift.");
    console.error("findings were:");
    for (const line of allFindings) console.error(line);
    process.exit(1);
  }
  console.log("\n✓ --self-test: negative case produced the expected drift:");
  for (const line of allFindings) console.log(line);
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");

  const { inventories, skips, verifiedChecks } = await gatherInventories();

  for (const s of skips) console.log(`⊘ ${s}`);

  const findings = [];
  for (const inv of inventories) {
    findings.push(...validateManifestMembers(inv.manifestValidationLabel, inv.manifestMembers));
    findings.push(...compareMembers(inv.label, inv.installed, inv.manifestMembers));
  }
  findings.push(...checkVerifiedLogs(verifiedChecks));
  // README compat tables are generated FROM the verified logs — a stale
  // table fails this same gate (the root README's "cannot silently go
  // stale" claim is enforced here, not merely asserted).
  findings.push(...(await checkCompatStaleness()));

  // The site's frameworks page + llms.txt render from a committed
  // site/src/data/compat.json generated off these same verified logs
  // (site/scripts/sync-compat.mjs). Workspace-only surface: the public
  // typescript-sdk mirror has no site/, so this check self-skips there.
  const siteSync = resolve(typescriptRoot, "..", "..", "site", "scripts", "sync-compat.mjs");
  if (existsSync(siteSync)) {
    try {
      execFileSync(process.execPath, [siteSync, "--check"], { stdio: "pipe" });
    } catch {
      findings.push(
        "  site: src/data/compat.json is STALE vs the verified logs — run `node site/scripts/sync-compat.mjs` (workspace root) and commit the result",
      );
    }
  }

  if (findings.length > 0) {
    console.error(`\n✖ facet SDK-surface drift detected (${findings.length} issue(s)):\n`);
    for (const line of findings) console.error(line);
    console.error(
      "\nFix — member drift: add an honest `disposition` (handled|carried|router-plane|not-applicable|silently-dropped) " +
        "+ `note` for every new member in the relevant sdk-surface.json, or remove an entry whose member the SDK dropped." +
        "\nFix — verified-log / compat-table drift: APPEND a `verified` entry (+ matching `verifiedAt`) after the " +
        "verification ritual passes, then run `node scripts/render-compat.mjs`.",
    );
    process.exit(1);
  }

  if (inventories.length === 0) {
    console.log("⊘ no facet SDK was resolvable in this environment — nothing to check (this is not a failure)");
  } else {
    for (const inv of inventories) {
      console.log(`✓ ${inv.label} in sync (${inv.installed.length} member(s) checked)`);
    }
  }

  if (selfTest) runSelfTest(inventories, verifiedChecks);
}

main().catch((err) => {
  console.error(`✖ check-fixture-drift crashed: ${err.stack || err.message}`);
  process.exit(1);
});
