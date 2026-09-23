/**
 * record.ts — lenient readers for STORED records (draft.4 §0.2, workspace#20
 * decision 6, founder ruling 2026-09-23: option 1, "omit the element, reject
 * the input").
 *
 * §0.2's consumer posture also binds a reader of a stored `AgMessage` or
 * `AgMemoryRecord` it did not receive inside an event. These readers
 * implement it:
 *
 * - A stored `AgMessage` is materialized only when its `id` is a string, its
 *   `role` an `AgRole`, its `content` an array and its other defined fields
 *   valid. Otherwise there is no value, and ONE report carries the whole record
 *   verbatim.
 * - An element of `content[]` that fails `AgBlock` at any depth (an undefined
 *   `type`, or an undefined value in a closed set inside a known block) is
 *   omitted WHOLE and reported with its index and verbatim value. A
 *   tool-result is omitted, never altered. The remaining elements keep their
 *   order.
 * - In an array of stored records, a record that fails is omitted and
 *   reported with its index. Nothing is ever coerced.
 * - Unknown object fields pass through untouched at every depth: every value
 *   returned is an own-property deep copy of the RAW input, never zod's output
 *   (which strips unknown keys). A key named `__proto__` is dropped at every
 *   depth (the shared copy stage-1 ingest uses). The input is never mutated.
 * - Inserting each report's `raw` at its reported index reproduces the stored
 *   record or array.
 *
 * What a reader returns is a VIEW. It MUST NOT be persisted in place of the
 * stored record: a component that persists or forwards a record keeps it as
 * received.
 *
 * Records carried by EVENTS are out of scope: they keep the whole-event rule
 * (ingest.ts). Disclosed, not fixed: a `messages.snapshot` holding one unknown
 * block fails `AgEvent`, becomes an `ext.agjson.ignored` stub and so cannot
 * un-park a live fold, while the same message read here from storage keeps its
 * readable blocks. That stays so until decision 5's snapshot leg is ruled.
 */
import { AgBlock, AgMemoryRecord, AgMessage, type JsonValue } from "./agjson.js";
import { copyJson } from "./copy-json.js";
import { isJsonValue, toJsonValueSafe } from "./wire.js";

/** One omitted element or record: where it was, its type when it had one, and its verbatim value. */
export interface AgRecordReport {
  /** From the value passed to the reader: `[]` for the whole record, `["content", i]` for an element, `[i]` or `[i, "content", j]` inside an array. */
  path: (string | number)[];
  /** The omitted element's `type`, when it is a string (a content element's block type). */
  ignoredType?: string;
  /** The omitted value, verbatim (an own-property copy; `__proto__` dropped). */
  raw: JsonValue;
}

/** The result of reading one stored record: a value when it was materialized, and every omission. */
export interface AgRecordRead<T> {
  value?: T;
  reports: AgRecordReport[];
}

/** The result of reading an array of stored records. */
export interface AgRecordsRead<T> {
  value: T[];
  reports: AgRecordReport[];
}

type JsonObject = { [k: string]: JsonValue };

const isObject = (v: JsonValue): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);

/** A value as a report can carry it: a JSON value is copied verbatim; a
 *  non-JSON one (never read from JSON storage) is made JSON-safe. */
const reportRaw = (v: unknown): JsonValue => (isJsonValue(v) ? copyJson(v) : toJsonValueSafe(v));

function report(path: (string | number)[], raw: unknown, ignoredType?: string): AgRecordReport {
  return { path, ...(ignoredType !== undefined ? { ignoredType } : {}), raw: reportRaw(raw) };
}

/**
 * Read one stored `AgMessage` (draft.4 §0.2). Omits and reports each
 * unreadable `content[]` element; a record that cannot be materialized has no
 * `value` and one report at path `[]`.
 */
export function readStoredAgMessage(raw: unknown): AgRecordRead<AgMessage> {
  if (!isJsonValue(raw) || !isObject(raw) || !Array.isArray(raw["content"])) return { reports: [report([], raw)] };
  const kept: JsonValue[] = [];
  const reports: AgRecordReport[] = [];
  raw["content"].forEach((element, i) => {
    if (AgBlock.safeParse(element).success) {
      kept.push(copyJson(element));
      return;
    }
    const type = isObject(element) && typeof element["type"] === "string" ? element["type"] : undefined;
    reports.push(report(["content", i], element, type));
  });
  // The copy keeps the stored key order, with the readable elements in place of content.
  const view: JsonObject = {};
  for (const k of Object.keys(raw)) {
    if (k === "__proto__") continue;
    Object.defineProperty(view, k, {
      value: k === "content" ? kept : copyJson(raw[k]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  // Every other defined field must be valid; else the whole record is reported.
  if (!AgMessage.safeParse(view).success) return { reports: [report([], raw)] };
  return { value: view as unknown as AgMessage, reports };
}

/** Read an array of stored `AgMessage`s: each unreadable message or element is omitted and reported, prefixed with its index. */
export function readStoredAgMessages(raws: readonly unknown[]): AgRecordsRead<AgMessage> {
  if (!Array.isArray(raws)) return { value: [], reports: [report([], raws)] };
  const value: AgMessage[] = [];
  const reports: AgRecordReport[] = [];
  raws.forEach((raw, i) => {
    const r = readStoredAgMessage(raw);
    if (r.value !== undefined) value.push(r.value);
    for (const rep of r.reports) reports.push({ ...rep, path: [i, ...rep.path] });
  });
  return { value, reports };
}

/** Read an array of stored `AgMemoryRecord`s: a record that fails (an undefined `scope`, a missing `value`, …) is omitted and reported at `[i]`. */
export function readStoredAgMemoryRecords(raws: readonly unknown[]): AgRecordsRead<AgMemoryRecord> {
  if (!Array.isArray(raws)) return { value: [], reports: [report([], raws)] };
  const value: AgMemoryRecord[] = [];
  const reports: AgRecordReport[] = [];
  raws.forEach((raw, i) => {
    if (isJsonValue(raw) && isObject(raw) && AgMemoryRecord.safeParse(raw).success) value.push(copyJson(raw) as unknown as AgMemoryRecord);
    else reports.push(report([i], raw));
  });
  return { value, reports };
}
