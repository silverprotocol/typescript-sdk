/**
 * vercel-mcp.corpus.test.ts — every committed vercel golden maps its MCP tool
 * results the way draft.4 requires. An @ai-sdk/mcp tool part carries the
 * framework's own stamp (`toolMetadata.clientName`), and its output is the MCP
 * CallToolResult. That result's `isError: true` folds as a tool.done with
 * outcome "error" and isError (§2.2), and its MCP Apps `_meta.ui` rides the
 * tool.done's `_meta` unchanged (§2.1 view locator). §10.41 also checks the
 * `_meta.ui` half across every framework; this test adds the outcome half for
 * vercel, which no §10 leg pins.
 *
 * It reads the COMMITTED goldens, so it pins the goldens' shape. It does not
 * replay: the replay deep-equal (replay.test.ts) pins the facet to those
 * goldens. A facet mutation shows up there and in §10.41, while this test
 * stays green until the goldens move.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS = join(import.meta.dirname, "..", "corpus");
type Obj = { [k: string]: unknown };
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);

describe("vercel goldens map @ai-sdk/mcp tool results per draft.4 (§2.2 outcome, §2.1 _meta.ui)", () => {
  it("every stamped MCP result: isError → outcome error + isError, else ok; _meta.ui → tool.done._meta.ui", () => {
    const wrong: string[] = [];
    let mcp = 0, errors = 0, uis = 0;
    for (const d of readdirSync(CORPUS).sort()) {
      const nat = join(CORPUS, d, "vercel.native.json");
      if (!existsSync(nat)) continue;
      const golden = JSON.parse(readFileSync(join(CORPUS, d, "vercel.agjson.json"), "utf8")) as Obj[];
      for (const part of JSON.parse(readFileSync(nat, "utf8")) as Obj[]) {
        if (part["type"] !== "tool-result" || typeof obj(part["toolMetadata"])?.["clientName"] !== "string") continue;
        const out = obj(part["output"]);
        if (out === undefined || !Array.isArray(out["content"])) continue;
        mcp++;
        const done = golden.find((e) => e["type"] === "tool.done" && e["toolCallId"] === part["toolCallId"]);
        const at = `${d} ${String(part["toolCallId"])}`;
        if (done === undefined) { wrong.push(`${at}: no tool.done`); continue; }
        if (out["isError"] === true) {
          errors++;
          if (done["outcome"] !== "error" || done["isError"] !== true) wrong.push(`${at}: isError result folded as outcome ${String(done["outcome"])}`);
        } else if (done["outcome"] !== "ok") wrong.push(`${at}: ok result folded as outcome ${String(done["outcome"])}`);
        const ui = obj(out["_meta"])?.["ui"];
        if (ui !== undefined) {
          uis++;
          if (JSON.stringify(obj(done["_meta"])?.["ui"]) !== JSON.stringify(ui)) wrong.push(`${at}: _meta.ui not on tool.done._meta`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // Non-vacuity: live error and MCP Apps legs are in the corpus.
    expect(mcp).toBeGreaterThanOrEqual(4);
    expect(errors).toBeGreaterThanOrEqual(1);
    expect(uis).toBeGreaterThanOrEqual(1);
  });
});
