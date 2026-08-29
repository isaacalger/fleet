import { describe, expect, it } from "vitest";
import { TriageResultSchema } from "./contracts.ts";

const VALID = {
  status: "completed",
  summary: "The HUD reads the high score under a different mode key than the writer uses.",
  rootCause: "loadHighScore is called with state.mode before mode is assigned, so it reads an empty key.",
  evidence: ["src/main.js:38", "src/storage.js:8"],
  confidence: 85,
  spec: {
    problem: "Starting a new game shows 0 instead of the stored best.",
    acceptanceCriteria: "- High score persists across new games",
    verification: "npm test",
  },
};

describe("TriageResultSchema", () => {
  it("accepts a well-formed completed result", () => {
    const parsed = TriageResultSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it("rejects a confidence outside 0-100", () => {
    expect(TriageResultSchema.safeParse({ ...VALID, confidence: 101 }).success).toBe(false);
    expect(TriageResultSchema.safeParse({ ...VALID, confidence: -1 }).success).toBe(false);
  });

  it("rejects a fractional confidence", () => {
    expect(TriageResultSchema.safeParse({ ...VALID, confidence: 82.5 }).success).toBe(false);
  });

  it("defaults evidence to an empty array", () => {
    const { evidence, ...withoutEvidence } = VALID;
    const parsed = TriageResultSchema.safeParse(withoutEvidence);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.evidence).toEqual([]);
  });

  it("accepts a blocked result carrying a reason", () => {
    const parsed = TriageResultSchema.safeParse({
      ...VALID,
      status: "blocked",
      blockedReason: "Cannot reproduce without knowing which browser.",
    });
    expect(parsed.success).toBe(true);
  });
});
