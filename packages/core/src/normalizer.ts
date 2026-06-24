import jsonata from "jsonata";
import { AgEvent } from "./agjson.js";

// A rule-normalizer translates one framework's wire I/O into AgJSON events via a
// pure function. Concrete normalizers (the @silverprotocol/<framework> packages)
// are typed `RuleNormalizer<SDKMessage>` etc.; `fromJsonata` returns
// `RuleNormalizer<unknown>` — the `unknown` is the genuine JSONata input boundary
// (any JSON value, spec §0.1), not shaped data.
// NOTE: renamed from `Normalizer<TInput>` to free the name for the stateful push/flush
// interface (StreamAssembler).
export type RuleNormalizer<TInput> = (input: TInput) => AgEvent[] | Promise<AgEvent[]>;

// Typed error for the normalization boundary (e.g. the timeout/over-budget guard),
// distinct from a Zod validation error on the produced events.
export class NormalizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizerError";
  }
}

// Build a normalizer from a portable JSONata rule (the structural-mapping half;
// stateful bits drop to a TS function in the concrete normalizers, spec §8).
// A LIGHT timeout bound only — rules are vetted packages, not untrusted runtime
// data. The bound guards async-hanging rules; a CPU-bound rule blocks the loop and
// is the caller's responsibility (the rules are reviewed). Each produced value is
// validated against `AgEvent`; a validation failure throws (the Router's per-event
// guard catches it and emits a graceful per-event error).
export function fromJsonata(rule: string, opts: { timeoutMs?: number } = {}): RuleNormalizer<unknown> {
  const expr = jsonata(rule);
  const timeoutMs = opts.timeoutMs ?? 250;
  return async (input) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NormalizerError("jsonata rule timed out")), timeoutMs);
    });
    try {
      const raw = await Promise.race([expr.evaluate(input), timeout]);
      const arr = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      return arr.map((e) => AgEvent.parse(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
