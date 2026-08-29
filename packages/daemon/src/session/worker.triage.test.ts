import { describe, expect, it } from "vitest";
import { TRIAGE_OUTPUT_SCHEMA, buildSystemPromptAppend, isForbiddenPlanBashCommand } from "./worker.ts";

describe("triage session kind", () => {
  it("exposes a draft-7 output schema with no top-level conditionals", () => {
    expect(TRIAGE_OUTPUT_SCHEMA).toBeTruthy();
    expect(TRIAGE_OUTPUT_SCHEMA.oneOf).toBeUndefined();
    expect(TRIAGE_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(TRIAGE_OUTPUT_SCHEMA.anyOf).toBeUndefined();
  });

  it("describes the confidence field, since the model reads these descriptions", () => {
    const props = (TRIAGE_OUTPUT_SCHEMA as { properties: Record<string, { description?: string }> }).properties;
    expect(props.confidence?.description).toBeTruthy();
  });

  it("uses a triage-specific system prompt", () => {
    const append = buildSystemPromptAppend("triage");
    expect(append).toContain("triage");
    expect(append).toContain("systematic-debugging");
    expect(append).not.toContain("Commit incrementally");
  });

  // Triage reuses the planner's read-only guard predicate, so commits and pushes are denied.
  it("reuses the read-only bash guard, so commits and pushes are denied", () => {
    expect(isForbiddenPlanBashCommand("git commit -m wip")).toBe(true);
    expect(isForbiddenPlanBashCommand("git push")).toBe(true);
    expect(isForbiddenPlanBashCommand("npm test")).toBe(false);
  });
});
