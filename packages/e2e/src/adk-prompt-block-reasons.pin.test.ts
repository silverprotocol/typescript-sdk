/**
 * The google-adk facet treats every prompt-block reason that @google/genai
 * defines. A genai bump that adds a `BlockedReason` value fails this test
 * instead of letting that block fall through to the facet's generic close.
 * `BLOCK_REASON_UNSPECIFIED` is the Gemini API's own spelling of the
 * unspecified reason, which the facet also admits.
 *
 * `BlockedReason` is read from the @google/genai that @google/adk resolves,
 * the copy whose responses the facet meets at runtime, not from this
 * package's own genai pin (the two can differ after a bump). The import runs
 * at module load, outside any timed test.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { ADK_PROMPT_BLOCK_REASONS } from "@silverprotocol/google-adk";

const adkPackageJson = createRequire(import.meta.url).resolve("@google/adk/package.json");
const genaiEntry = createRequire(adkPackageJson).resolve("@google/genai");
const { BlockedReason } = (await import(pathToFileURL(genaiEntry).href)) as { BlockedReason: Record<string, string> };

describe("google-adk prompt-block reasons cover @google/genai's BlockedReason", () => {
  it("treats every BlockedReason value (from the genai @google/adk resolves) and the Gemini API's BLOCK_REASON_UNSPECIFIED", () => {
    const treated = new Set<string>(ADK_PROMPT_BLOCK_REASONS);
    const required = [...Object.values(BlockedReason), "BLOCK_REASON_UNSPECIFIED"];
    expect(Object.values(BlockedReason).length).toBeGreaterThan(0);
    expect(required.filter((reason) => !treated.has(reason))).toEqual([]);
  });
});
