import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CONFIDENCE, makeCtx, makeFleetConfig, makeIssue, makeProject, makeRecord } from "../test-support.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  upsertStatusComment: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  addLabel: vi.fn(async () => {}),
  createPullRequest: vi.fn(async () => "https://github.com/acme/alpha/pull/1"),
  createIssue: vi.fn(async () => 99),
  getIssueComments: vi.fn(async () => []),
  getIssue: vi.fn(async () => undefined),
}));

vi.mock("../github/worktree.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/worktree.ts")>()),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "diff --git a b", commits: "abc123 fix" })),
}));

vi.mock("../session/review.ts", async (importActual) => ({
  ...(await importActual<typeof import("../session/review.ts")>()),
  runMachineReview: vi.fn(async () => ({ costUsd: 0, result: { verdict: "pass" as const, summary: "ok", confidence: TEST_CONFIDENCE, findings: [] } })),
  runPlanReview: vi.fn(async () => ({ costUsd: 0, result: { verdict: "pass" as const, summary: "ok", confidence: TEST_CONFIDENCE, findings: [] } })),
}));

vi.mock("./finish.ts", async (importActual) => ({
  ...(await importActual<typeof import("./finish.ts")>()),
  finishCompleted: vi.fn(async () => {}),
  finishPlanned: vi.fn(async () => {}),
  finishBlocked: vi.fn(async () => {}),
  finishFailed: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");
const worktreeMod = await import("../github/worktree.ts");
const review = await import("../session/review.ts");
const finish = await import("./finish.ts");
const { resolveTimeoutMinutes, supervise } = await import("./supervise.ts");

describe("resolveTimeoutMinutes", () => {
  it("falls back to the global ticketTimeoutMinutes when the body has no Timeout line", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Just a plain description.")).toBe(30);
  });

  it("honors a per-ticket Timeout override under the max", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: 90m")).toBe(90);
  });

  it("clamps a Timeout above the max and still returns the clamped value", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: 6h")).toBe(240);
  });

  it("falls back to the global value when the Timeout line is malformed", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: soon")).toBe(30);
  });
});

const worktree = { path: "/tmp/wt/7", branch: "fleet/7" };
const base = { costUsd: 0, modelUsage: undefined } as never;

/** Serves exactly one turn; a second `nextResult` means supervise failed to return. */
function fakeSession(turn: Record<string, unknown>) {
  let served = false;
  return {
    costUsd: 0,
    sessionId: "sess-1",
    model: "m",
    effort: undefined,
    modelUsage: undefined,
    send: vi.fn(),
    close: vi.fn(),
    nextResult: async () => {
      if (served) throw new Error("supervise did not return after the terminal turn");
      served = true;
      return turn;
    },
  } as never;
}

function codeCtx() {
  const ctx = makeCtx();
  ctx.state.upsert(makeRecord({ issueNumber: 7, worktreePath: worktree.path, branch: worktree.branch }));
  return ctx;
}

describe("supervise confidence gate — code stage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeMod.hasCommits).mockResolvedValue(true);
    vi.mocked(github.getIssue).mockResolvedValue(undefined);
    vi.mocked(review.runMachineReview).mockResolvedValue({
      costUsd: 0,
      result: { verdict: "pass", summary: "ok", confidence: TEST_CONFIDENCE, findings: [] },
    });
  });

  it("holds a low-confidence completion without buying a reviewer session", async () => {
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const turn = { kind: "code", result: { status: "completed", summary: "s", confidence: 65 } };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession(turn), base);

    expect(review.runMachineReview).not.toHaveBeenCalled();
    expect(worktreeMod.pushBranch).not.toHaveBeenCalled();
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(finish.finishCompleted).not.toHaveBeenCalled();
    expect(finish.finishBlocked).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(finish.finishBlocked).mock.calls[0]![3])).toContain("below the 70% threshold");
  });

  it("runs the machine reviewer and the normal path at or above the threshold", async () => {
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const turn = { kind: "code", result: { status: "completed", summary: "s", confidence: 70 } };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession(turn), base);

    expect(review.runMachineReview).toHaveBeenCalledTimes(1);
    expect(finish.finishCompleted).toHaveBeenCalledTimes(1);
    expect(finish.finishBlocked).not.toHaveBeenCalled();
  });
});

describe("supervise confidence gate — plan and reviewer stages", () => {
  const planTicket = { title: "T", body: "## Problem\n\np\n\n## Acceptance criteria\n\n- [ ] a\n\n## Verification\n\nv" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeMod.hasCommits).mockResolvedValue(true);
    vi.mocked(github.getIssue).mockResolvedValue(undefined);
  });

  it("holds a low-confidence plan without buying a reviewer session or filing children", async () => {
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const result = { status: "completed", summary: "s", confidence: 65, tickets: [planTicket] };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession({ kind: "plan", result }), base);

    expect(review.runPlanReview).not.toHaveBeenCalled();
    expect(finish.finishPlanned).not.toHaveBeenCalled();
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(finish.finishBlocked).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(finish.finishBlocked).mock.calls[0]![3])).toContain("below the 70% threshold");
  });

  it("holds when the machine reviewer itself reports low confidence", async () => {
    vi.mocked(review.runMachineReview).mockResolvedValue({
      costUsd: 0,
      result: { verdict: "pass", summary: "Probably fine?", confidence: 40, findings: [] },
    });
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const turn = { kind: "code", result: { status: "completed", summary: "s", confidence: TEST_CONFIDENCE } };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession(turn), base);

    expect(worktreeMod.pushBranch).not.toHaveBeenCalled();
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(finish.finishCompleted).not.toHaveBeenCalled();
    expect(String(vi.mocked(finish.finishBlocked).mock.calls[0]![3])).toContain("machine-review confidence 40%");
  });

  it("holds when the plan reviewer itself reports low confidence", async () => {
    vi.mocked(review.runPlanReview).mockResolvedValue({
      costUsd: 0,
      result: { verdict: "pass", summary: "Probably fine?", confidence: 40, findings: [] },
    });
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const result = { status: "completed", summary: "s", confidence: TEST_CONFIDENCE, tickets: [planTicket] };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession({ kind: "plan", result }), base);

    expect(finish.finishPlanned).not.toHaveBeenCalled();
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(String(vi.mocked(finish.finishBlocked).mock.calls[0]![3])).toContain("plan-review confidence 40%");
  });

  it("still proceeds when the reviewer crashes — fail-open is untouched", async () => {
    vi.mocked(review.runMachineReview).mockRejectedValue(new Error("reviewer exploded"));
    const ctx = codeCtx();
    const project = makeProject({ machineReview: true, confidenceThreshold: 70 });
    const turn = { kind: "code", result: { status: "completed", summary: "s", confidence: TEST_CONFIDENCE } };

    await supervise(ctx, project, makeIssue(7, ["fleet:in-progress"]), worktree, fakeSession(turn), base);

    expect(finish.finishCompleted).toHaveBeenCalledTimes(1);
    expect(finish.finishBlocked).not.toHaveBeenCalled();
  });
});
