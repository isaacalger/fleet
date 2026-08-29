import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TriageResult } from "@fleet/shared";
import { makeCtx, makeIssue, makeProject, makeRecord } from "../test-support.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  upsertStatusComment: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  addLabel: vi.fn(async () => {}),
  appendTriageSpecSafely: vi.fn(async () => "appended" as const),
}));

const github = await import("../github/github.ts");
const { finishTriaged } = await import("./finish.ts");

const RESULT: TriageResult = {
  status: "completed",
  summary: "s",
  rootCause: "rc",
  evidence: ["src/a.js:1"],
  confidence: 85,
  spec: { problem: "p", acceptanceCriteria: "- a", verification: "npm test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(github.appendTriageSpecSafely).mockResolvedValue("appended");
});

function setup(threshold: number) {
  const ctx = makeCtx();
  ctx.state.upsert(makeRecord({ project: "alpha", issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
  const project = makeProject({ triage: true, triageAutoPromoteThreshold: threshold });
  return { ctx, project, issue: makeIssue(7) };
}

describe("finishTriaged", () => {
  it("promotes to fleet:ready when confidence meets the threshold", async () => {
    const { ctx, project, issue } = setup(80);
    await finishTriaged(ctx, project, issue, RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:ready");
    expect(github.swapLabel).toHaveBeenCalledTimes(1);
  });

  it("promotes at exactly the threshold — the comparison is >=", async () => {
    const { ctx, project, issue } = setup(85);
    await finishTriaged(ctx, project, issue, RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:ready");
  });

  it("holds below the threshold", async () => {
    const { ctx, project, issue } = setup(90);
    await finishTriaged(ctx, project, issue, RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(github.swapLabel).toHaveBeenCalledTimes(1);
  });

  it("never promotes when the body was edited mid-run, even at 100 confidence with a 0 threshold", async () => {
    vi.mocked(github.appendTriageSpecSafely).mockResolvedValue("commented");
    const { ctx, project, issue } = setup(0);
    await finishTriaged(ctx, project, issue, { ...RESULT, confidence: 100 });
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("never promotes a blocked result", async () => {
    const { ctx, project, issue } = setup(0);
    await finishTriaged(ctx, project, issue, { ...RESULT, status: "blocked", blockedReason: "which browser?" });
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("passes the claim-time body hash through to the safe append", async () => {
    const { ctx, project, issue } = setup(80);
    await finishTriaged(ctx, project, issue, RESULT);
    expect(github.appendTriageSpecSafely).toHaveBeenCalledWith(project, 7, expect.stringContaining("## Problem"), "h");
  });

  it("persists the reported confidence for later threshold tuning", async () => {
    const { ctx, project, issue } = setup(80);
    await finishTriaged(ctx, project, issue, RESULT);
    expect(ctx.state.get("alpha", 7)?.triageConfidence).toBe(85);
  });

  it("applies the suggested tier label before promoting", async () => {
    const { ctx, project, issue } = setup(80);
    await finishTriaged(ctx, project, issue, { ...RESULT, suggestedTier: "light" });
    expect(github.addLabel).toHaveBeenCalledWith(project, 7, "fleet:light");
    expect(vi.mocked(github.addLabel).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(github.swapLabel).mock.invocationCallOrder[0]!,
    );
  });

  it("posts a status comment naming the root cause and confidence", async () => {
    const { ctx, project, issue } = setup(80);
    await finishTriaged(ctx, project, issue, RESULT);
    const body = vi.mocked(github.upsertStatusComment).mock.calls[0]![2];
    expect(body).toContain("rc");
    expect(body).toContain("85%");
  });
});
