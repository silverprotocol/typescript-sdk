/**
 * The one reduction every engine-built relay native passes before it is written (the oracle and in-band error
 * fixture sets). ADK's RemoteA2AAgent records the A2A traffic of each relayed event under `customMetadata`
 * (`a2a:request`, `a2a:response`, `a2a:task_id`, `a2a:context_id`). The fixtures are public, so each entry keeps
 * only what a fold or a facet rule reads (RELAY_KEEP): `a2a:response` keeps `kind` and an artifact's `artifactId`
 * (the relay stream a window rule keys on), the task and context ids stay whole (the relay-repeat rule compares the
 * task id), and any other relay entry, `a2a:request` included, keeps no member. A writer refuses a native whose
 * entry still holds more (relayEntriesReduced). No @google/adk import: the gate collects the generators that use it.
 */
export const RELAY_KEEP: Record<string, readonly string[] | "all"> = { "a2a:response": ["kind", "artifact.artifactId"], "a2a:task_id": "all", "a2a:context_id": "all" };

const pick = (v: unknown, paths: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const keys = path.split(".");
    let src: unknown = v;
    for (const k of keys) src = src && typeof src === "object" ? (src as Record<string, unknown>)[k] : undefined;
    if (src === undefined) continue;
    let dst = out;
    keys.slice(0, -1).forEach((k) => { dst = (dst[k] ??= {}) as Record<string, unknown>; });
    dst[keys[keys.length - 1]!] = src;
  }
  return out;
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
