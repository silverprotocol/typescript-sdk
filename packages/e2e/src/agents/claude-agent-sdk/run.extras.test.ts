// The query() options behind CaptureRunInput.preToolUseDecision /
// resumeSessionId (R&D candidate 20's live capture: a PreToolUse `defer`, then
// resume legs that allow or deny). Exercised WITHOUT the SDK: the builder is
// pure, and the installed hook is called directly.
import { describe, expect, it } from "vitest";
import { captureQueryExtras } from "./run.js";

describe("captureQueryExtras — PreToolUse decision hook + resume", () => {
  it("absent ⇒ no keys at all (byte-identical query options)", () => {
    expect(captureQueryExtras({})).toEqual({});
  });

  it.each(["defer", "allow", "deny"] as const)("'%s' installs ONE PreToolUse hook that returns exactly that permissionDecision", async (decision) => {
    const extras = captureQueryExtras({ preToolUseDecision: decision });
    expect(Object.keys(extras)).toEqual(["hooks"]);
    const matchers = extras.hooks?.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    const hook = matchers[0]?.hooks[0];
    expect(hook).toBeDefined();
    const out = await hook!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_1" } as never,
      "toolu_1",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } });
  });

  it("resumeSessionId → `resume`, alone or beside the hook", () => {
    expect(captureQueryExtras({ resumeSessionId: "sess_leg1" })).toEqual({ resume: "sess_leg1" });
    const both = captureQueryExtras({ preToolUseDecision: "allow", resumeSessionId: "sess_leg1" });
    expect(Object.keys(both).sort()).toEqual(["hooks", "resume"]);
  });
});
