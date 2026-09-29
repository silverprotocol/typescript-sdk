/**
 * The one reduction every engine-built relay native passes before it is written (the oracle and in-band error
 * fixture sets). ADK's RemoteA2AAgent records the A2A traffic of each relayed event under `customMetadata`
 * (`a2a:request`, `a2a:response`, `a2a:task_id`, `a2a:context_id`). The fixtures are public, so each entry keeps
 * only what a fold or a facet rule reads (RELAY_KEEP), all of it structure, none of it text:
 *   - `a2a:response` keeps `kind`, an artifact update's `artifactId` (the relay stream a window rule keys on), the
 *     status `state` and its message's `role` (a relayed repeat of the forwarded request is a submitted, user-role
 *     status), and a recorded task's artifacts as their `artifactId` and each part's `kind` only (the number of parts
 *     the repeat follows); a status message's parts are never kept;
 *   - the task and context ids stay whole (the relay-repeat rule compares the task id);
 *   - any other relay entry, `a2a:request` included, keeps no member.
 * A path segment ending in `[]` keeps that array, each element reduced by the rest of the path; a `[]` segment is
 * never last (it would keep each element whole). A writer refuses a native whose
 * entry still holds more (relayEntriesReduced). No @google/adk import: the gate collects the generators that use it.
 */
export const RELAY_KEEP: Record<string, readonly string[] | "all"> = {
  "a2a:response": ["kind", "artifact.artifactId", "status.state", "status.message.role", "artifacts[].artifactId", "artifacts[].parts[].kind"],
  "a2a:task_id": "all",
  "a2a:context_id": "all",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The part of `v` one path keeps, or undefined when the path is absent. */
function pickPath(v: unknown, segs: readonly string[]): unknown {
  if (segs.length === 0) return v;
  const [seg, ...rest] = segs as [string, ...string[]];
  const array = seg.endsWith("[]");
  const key = array ? seg.slice(0, -2) : seg;
  if (!isObj(v) || !(key in v)) return undefined;
  const child = v[key];
  if (array) {
    // A `[]` segment names the elements a later segment reduces; as the last segment it would keep each element
    // whole, text included, and the guard would approve it.
    if (rest.length === 0) throw new Error(`relay reduction path segment \`${seg}\` must be followed by the member it keeps`);
    if (!Array.isArray(child)) return undefined;
    return { [key]: child.map((el) => pickPath(el, rest) ?? {}) };
  }
  const inner = pickPath(child, rest);
  return inner === undefined ? undefined : { [key]: inner };
}
/** Deep merge of two picks of the same value (objects by key, arrays by index). */
function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
  if (isObj(a) && isObj(b)) { const out: Record<string, unknown> = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v; return out; }
  return b === undefined ? a : b;
}
/** Exported for its unit test: the part of `v` the given paths keep. */
export const pick = (v: unknown, paths: readonly string[]): Record<string, unknown> => {
  let out: unknown = {};
  for (const path of paths) { const p = pickPath(v, path.split(".")); if (p !== undefined) out = merge(out, p); }
  return out as Record<string, unknown>;
};

/** Relay customMetadata entries reduced to what the fold needs (RELAY_KEEP). */
export function reduceRelayEntries(natives: Record<string, unknown>[]): Record<string, unknown>[] {
  return natives.map((ev) => {
    const cm = ev["customMetadata"];
    if (!cm || typeof cm !== "object" || Array.isArray(cm)) return ev;
    const out: Record<string, unknown> = { ...(cm as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) if (k.startsWith("a2a:") && RELAY_KEEP[k] !== "all") out[k] = pick(v, (RELAY_KEEP[k] as readonly string[] | undefined) ?? []);
    return { ...ev, customMetadata: out };
  });
}

/** true when every relay entry of every native holds only what RELAY_KEEP lets it keep. */
export const relayEntriesReduced = (natives: Record<string, unknown>[]): boolean =>
  natives.every((ev) => Object.entries((ev["customMetadata"] ?? {}) as Record<string, unknown>).every(([k, v]) => !k.startsWith("a2a:") || RELAY_KEEP[k] === "all" || JSON.stringify(v) === JSON.stringify(pick(v, (RELAY_KEEP[k] as readonly string[] | undefined) ?? []))));
