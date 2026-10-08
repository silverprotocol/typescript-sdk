/**
 * depth.ts — INTERNAL (not re-exported from index.ts).
 *
 * The nesting check run before a value reaches a recursive reader (the schema
 * parse, structuredClone, a JSON Patch application), so that a value nested
 * past a bound is turned away instead of overflowing the call stack.
 */

/**
 * True when some node of `v` sits deeper than `max`, the root at depth 0 and a
 * node's depth the number of containers above it. The walk is iterative, so it
 * never overflows the stack, and a node reached again is walked again only
 * when it is reached deeper than before; a cycle is therefore too deep. It
 * never throws: a value it cannot read (a getter or proxy trap that throws)
 * answers false, leaving that value to the paths that handled it before.
 */
export function exceedsDepth(v: unknown, max: number): boolean {
  try {
    const deepest = new WeakMap<object, number>();
    const stack: Array<[unknown, number]> = [[v, 0]];
    while (stack.length > 0) {
      const [x, depth] = stack.pop()!;
      if (depth > max) return true;
      if (x === null || typeof x !== "object") continue;
      const seen = deepest.get(x);
      if (seen !== undefined && seen >= depth) continue;
      deepest.set(x, depth);
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) stack.push([x[i], depth + 1]);
        continue;
      }
      for (const k of Object.keys(x)) stack.push([(x as Record<string, unknown>)[k], depth + 1]);
    }
    return false;
  } catch {
    return false;
  }
}
