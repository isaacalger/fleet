import { lintIntakeBody } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { renderTriageSpec } from "./triage.ts";

const RESULT = {
  status: "completed" as const,
  summary: "s",
  rootCause: "loadHighScore reads an empty mode key",
  evidence: ["src/main.js:38", "src/storage.js:8"],
  confidence: 85,
  spec: {
    problem: "Starting a new game shows 0 instead of the stored best.",
    acceptanceCriteria: "- [ ] High score persists across new games",
    verification: "`npm test` passes",
  },
};

describe("renderTriageSpec", () => {
  it("emits the three headings intake lint requires", () => {
    const md = renderTriageSpec(RESULT);
    expect(md).toContain("## Problem");
    expect(md).toContain("## Acceptance criteria");
    expect(md).toContain("## Verification");
  });

  it("produces a body that passes intake lint", () => {
    expect(lintIntakeBody(renderTriageSpec(RESULT), { isPlan: false })).toEqual([]);
  });

  it("includes the root cause and evidence", () => {
    const md = renderTriageSpec(RESULT);
    expect(md).toContain("loadHighScore reads an empty mode key");
    expect(md).toContain("src/storage.js:8");
  });

  it("omits the evidence section when there is none", () => {
    const md = renderTriageSpec({ ...RESULT, evidence: [] });
    expect(md).not.toContain("Evidence");
  });

  it("includes the confidence percentage", () => {
    expect(renderTriageSpec(RESULT)).toContain("85%");
  });
});
