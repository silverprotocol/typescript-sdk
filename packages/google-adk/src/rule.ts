/**
 * Loads the canonical portable JSONata rule (`rule.jsonata`, the cross-runtime
 * structural-subset reference) as a string. The `.jsonata` file is the single
 * source of truth; this module exposes it so `index.ts` can re-export it and a
 * JSONata engine (`fromJsonata`) can consume it without a build step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ruleJsonata: string = readFileSync(
  fileURLToPath(new URL("./rule.jsonata", import.meta.url)),
  "utf8",
);
