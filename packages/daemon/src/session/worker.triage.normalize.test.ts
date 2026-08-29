import { describe, expect, it } from "vitest";
import type { TriageResult } from "@fleet/shared";
import { normalizeTriageResult } from "./worker.ts";

function triage(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    status: "completed",
    summary: "one line",
    rootCause: "off-by-one in the loop bound",
    evidence: ["src/storage.js:8"],
    confidence: 90,
    spec: { problem: "problem", acceptanceCriteria: "criteria", verification: "verify" },
    ...overrides,
  };
}

describe("normalizeTriageResult", () => {
  it("unescapes literal \\n in the markdown fields the promoted issue body is built from", () => {
    const out = normalizeTriageResult(triage({
      summary: "line one\\nline two",
      blockedReason: "why\\nnot",
      spec: {
        problem: "## Problem\\nthe thing is broken",
        acceptanceCriteria: "- [ ] a\\n- [ ] b",
        verification: "pnpm test\\npnpm typecheck",
      },
    }));
    expect(out.summary).toBe("line one\nline two");
    expect(out.blockedReason).toBe("why\nnot");
    expect(out.spec.problem).toBe("## Problem\nthe thing is broken");
    expect(out.spec.acceptanceCriteria).toBe("- [ ] a\n- [ ] b");
    expect(out.spec.verification).toBe("pnpm test\npnpm typecheck");
  });

  it("leaves rootCause and evidence alone", () => {
    const out = normalizeTriageResult(triage({ rootCause: "a\\nb", evidence: ["src/a.ts:1\\n"] }));
    expect(out.rootCause).toBe("a\\nb");
    expect(out.evidence).toEqual(["src/a.ts:1\\n"]);
  });

  it("passes unescaped values through byte-identical", () => {
    const input = triage({ summary: "real\nnewline", spec: { problem: "a\nb", acceptanceCriteria: "c", verification: "d" } });
    const out = normalizeTriageResult(input);
    expect(out).toEqual(input);
  });

  it("copies the nested spec object rather than mutating the input", () => {
    const input = triage({ spec: { problem: "a\\nb", acceptanceCriteria: "c", verification: "d" } });
    const out = normalizeTriageResult(input);
    expect(out).not.toBe(input);
    expect(out.spec).not.toBe(input.spec);
    expect(input.spec.problem).toBe("a\\nb");
  });
});
