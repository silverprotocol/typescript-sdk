/**
 * SPEC §8.0: a Normalizer constructed with no `threadId` stamps a facet-local placeholder that is not a partition
 * root, and its documentation MUST say so. Each facet README states it in the paragraph that documents the
 * `threadId` option; this gate reads that statement, whitespace collapsed (a README wraps its lines anywhere).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PHRASE = "a facet-local placeholder, not a partition root";
const FACETS = ["claude-agent-sdk", "openai-agents", "google-adk", "vercel-ai"] as const;
const readme = (facet: string) => readFileSync(new URL(`../../${facet}/README.md`, import.meta.url), "utf8");

/** The statement's paragraph, when a paragraph that names `threadId` carries the phrase; else null. */
function placeholderParagraph(text: string): string | null {
  for (const para of text.split(/\n\s*\n/)) {
    const flat = para.replace(/\s+/g, " ");
    if (flat.includes(PHRASE) && flat.includes("threadId")) return flat;
  }
  return null;
}

describe("facet READMEs say the no-threadId value is a facet-local placeholder, not a partition root (SPEC §8.0)", () => {
  for (const facet of FACETS) {
    it(`${facet}/README.md states it in its threadId paragraph`, () => {
      expect(placeholderParagraph(readme(facet)), facet).not.toBeNull();
    });
  }

  it("a README whose statement is removed or reworded fails the check", () => {
    for (const facet of FACETS) {
      const text = readme(facet);
      const flat = text.replace(/\s+/g, " ");
      expect(flat.includes(PHRASE), facet).toBe(true);
      const reworded = flat.replace(PHRASE, "a facet-local label");
      expect(placeholderParagraph(reworded), facet).toBeNull();
    }
  });
});
