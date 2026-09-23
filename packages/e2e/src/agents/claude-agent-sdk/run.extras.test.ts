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

  it("resumeSessionId → `resume` + `forkSession: true` together (each resume leg branches from the saved session, never from another leg)", () => {
    expect(captureQueryExtras({ resumeSessionId: "sess_leg1" })).toEqual({ resume: "sess_leg1", forkSession: true });
    const both = captureQueryExtras({ preToolUseDecision: "allow", resumeSessionId: "sess_leg1" });
    expect(Object.keys(both).sort()).toEqual(["forkSession", "hooks", "resume"]);
    expect(both.forkSession).toBe(true);
  });

  it("NEGATIVE CONTROL: no resumeSessionId ⇒ no forkSession key (a decision alone adds only `hooks`)", () => {
    expect(captureQueryExtras({ preToolUseDecision: "defer" })).not.toHaveProperty("forkSession");
  });
});
