/**
 * provenance.ts — the cassette provenance sidecar contract (Task 6 / audit
 * M60 §2.B).
 *
 * Every `corpus/<scn>/<fw>.native.json` ships a sibling
 * `corpus/<scn>/<fw>.provenance.json` recording WHERE the cassette's bytes
 * came from — a real captured provider run, or a hand-authored fixture — so
 * an outsider can distinguish real-provider evidence from fixtures without
 * spelunking git history or prose task reports (the audit's "outsider cannot
 * distinguish real-provider evidence from hand-authored fixtures" blast).
 *
 * Shape LOCKED by the Task 6 brief:
 *   { kind: "capture"|"fixture", capturedAt: string|null,
 *     sdkVersion: string|null, model: string|null, note?: string }
 *
 * Unknown metadata is `null`, never invented — see the Task 6 report's
 * provenance table for how each committed sidecar's fields were sourced
 * (native-cassette field extraction + git history + prior task reports, NOT
 * guesswork).
 */

export type ProvenanceKind = "capture" | "fixture";

export interface ProvenanceSidecar {
  kind: ProvenanceKind;
  capturedAt: string | null;
  sdkVersion: string | null;
  model: string | null;
  note?: string;
}

const PROVENANCE_KINDS: readonly string[] = ["capture", "fixture"] satisfies ProvenanceKind[];

/** Type-predicate guard — narrows a parsed JSON value to the literal
 *  `ProvenanceKind` union by membership (mirrors replay.ts's isFramework /
 *  isReviewedShape pattern — no cast on the value). */
export function isProvenanceKind(v: unknown): v is ProvenanceKind {
  return typeof v === "string" && PROVENANCE_KINDS.includes(v);
}
