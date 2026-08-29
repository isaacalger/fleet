import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TriageResult } from "@fleet/shared";
import { makeCtx, makeIssue, makeProject, makeRecord } from "../test-support.ts";

const hoisted = vi.hoisted(() => ({
  sessionOpts: [] as Array<Record<string, unknown>>,
  turns: [] as Array<Record<string, unknown>>,
}));

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  upsertStatusComment: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  addLabel: vi.fn(async () => {}),
  appendTriageSpecSafely: vi.fn(async () => "appended" as const),
  addAssignee: vi.fn(async () => {}),
  removeAssignee: vi.fn(async () => {}),
  getIssueAssignees: vi.fn(async () => ["daemon-user"]),
  getAuthenticatedLogin: vi.fn(async () => "daemon-user"),
  getIssueComments: vi.fn(async () => []),
  getIssue: vi.fn(async () => undefined),
  removeLabel: vi.fn(async () => {}),
}));

vi.mock("../github/worktree.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/worktree.ts")>()),
  createWorktree: vi.fn(async () => ({ path: "/tmp/wt/7", branch: "fleet/7" })),
}));

// The real `finishTriaged` stays live (the suite below exercises it against the
// mocked `gh` helpers); `finishFailed`/`reportRunFailure` are stubbed since the
// wiring tests only care that they were reached.
vi.mock("./finish.ts", async (importActual) => {
  const actual = await importActual<typeof import("./finish.ts")>();
  return {
    ...actual,
    finishTriaged: vi.fn(actual.finishTriaged),
    finishFailed: vi.fn(async () => {}),
    reportRunFailure: vi.fn(async () => {}),
  };
});

vi.mock("../session/worker.ts", async (importActual) => {
  const actual = await importActual<typeof import("../session/worker.ts")>();
  class FakeSession {
    costUsd = 0;
    sessionId = "sess-1";
    model = "m";
    effort = undefined;
    modelUsage = undefined;
    abortController = new AbortController();
    constructor(opts: Record<string, unknown>) {
      hoisted.sessionOpts.push(opts);
    }
    send(): void {}
    close(): void {}
    async nextResult(): Promise<unknown> {
      return hoisted.turns.shift() ?? { kind: "code", errorSubtype: "stream_ended_without_result" };
    }
  }
  return { ...actual, WorkerSession: FakeSession };
});

const github = await import("../github/github.ts");
const finish = await import("./finish.ts");
const { finishTriaged } = finish;
const { selectEligibleReady, processTicket } = await import("./claim.ts");
const { applyIntakeLint } = await import("./intake.ts");
const { supervise } = await import("./supervise.ts");
const { resumeTicket } = await import("./runner.ts");
const hashBody = github.hashBody;

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
  hoisted.sessionOpts.length = 0;
  hoisted.turns.length = 0;
  vi.mocked(github.appendTriageSpecSafely).mockResolvedValue("appended");
  vi.mocked(github.getIssue).mockResolvedValue(undefined);
});

function setup(threshold: number) {
  const ctx = makeCtx();
  ctx.state.upsert(makeRecord({ project: "alpha", issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
  const project = makeProject({ triage: true, confidenceThreshold: threshold });
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

  it("holds with an ungated history entry when auto-promote is off", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ project: "alpha", issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
    const project = makeProject({ triage: true, confidenceThreshold: 70, triageAutoPromote: false });

    await finishTriaged(ctx, project, makeIssue(7), { ...RESULT, confidence: 95 });

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(ctx.state.get("alpha", 7)?.confidenceHistory?.at(-1)).toMatchObject({ stage: "triage", score: 95, threshold: null });
  });

  it("promotes a below-threshold triage carrying the operator override label", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "t", body: "b", labels: ["fleet:confidence-overridden"] } as never);
    const { ctx, project, issue } = setup(70);

    await finishTriaged(ctx, project, issue, { ...RESULT, confidence: 40 });

    expect(github.removeLabel).toHaveBeenCalledWith(project, 7, "fleet:confidence-overridden");
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:ready");
  });

  it("short-circuits a body collision before the gate, leaving the override unconsumed", async () => {
    vi.mocked(github.appendTriageSpecSafely).mockResolvedValue("commented");
    vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "t", body: "b", labels: ["fleet:confidence-overridden"] } as never);
    const { ctx, project, issue } = setup(70);

    await finishTriaged(ctx, project, issue, { ...RESULT, confidence: 40 });

    expect(github.removeLabel).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(ctx.state.get("alpha", 7)?.confidenceHistory?.at(-1)?.score).toBe(40);
  });

  it("short-circuits a blocked result before the gate, even at full confidence", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "t", body: "b", labels: ["fleet:confidence-overridden"] } as never);
    const { ctx, project, issue } = setup(70);

    await finishTriaged(ctx, project, issue, { ...RESULT, status: "blocked", blockedReason: "which browser?", confidence: 100 });

    expect(github.removeLabel).not.toHaveBeenCalled();
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

const ELIGIBILITY_OPTS = {
  openIssueNumbers: new Set<number>(),
  allIssueNumbers: new Set<number>(),
  isRunning: () => false,
  getRecord: () => undefined,
  projectName: "alpha",
  myLogin: "daemon-user",
};

describe("triage claim eligibility", () => {
  it("admits a fleet:triage issue when the project has triage enabled", () => {
    const candidates = [makeIssue(7, ["fleet:triage"])];
    const picked = selectEligibleReady(candidates, { ...ELIGIBILITY_OPTS, triageEnabled: true });
    expect(picked.map((i) => i.number)).toEqual([7]);
  });

  it("does not admit a fleet:triage issue when the project has triage disabled", () => {
    const candidates = [makeIssue(7, ["fleet:triage"])];
    const picked = selectEligibleReady(candidates, { ...ELIGIBILITY_OPTS, triageEnabled: false });
    expect(picked).toEqual([]);
  });

  it("still skips a fleet:triage issue that is already in progress", () => {
    const candidates = [makeIssue(7, ["fleet:triage", "fleet:in-progress"])];
    const picked = selectEligibleReady(candidates, { ...ELIGIBILITY_OPTS, triageEnabled: true });
    expect(picked).toEqual([]);
  });

  it("still skips a fleet:triage issue assigned to another daemon", () => {
    const candidates = [makeIssue(7, ["fleet:triage"], { assignees: ["someone-else"] })];
    const picked = selectEligibleReady(candidates, { ...ELIGIBILITY_OPTS, triageEnabled: true });
    expect(picked).toEqual([]);
  });

  it("leaves the fleet:ready path untouched", () => {
    const candidates = [makeIssue(7, ["fleet:ready"]), makeIssue(8, [])];
    const picked = selectEligibleReady(candidates, { ...ELIGIBILITY_OPTS, triageEnabled: false });
    expect(picked.map((i) => i.number)).toEqual([7]);
  });
});

describe("intake lint and triage", () => {
  it("does not reject a triage candidate whose body lacks the required sections", async () => {
    const ctx = makeCtx();
    const project = makeProject({ triage: true, intakeLint: true });
    const issues = [makeIssue(7, ["fleet:triage"], { body: "it crashes sometimes, idk" })];
    const passing = await applyIntakeLint(ctx, project, issues);
    expect(passing.map((i) => i.number)).toEqual([7]);
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("still rejects a non-triage issue with the same half-formed body", async () => {
    const ctx = makeCtx();
    const project = makeProject({ triage: true, intakeLint: true });
    const issues = [makeIssue(7, ["fleet:ready"], { body: "it crashes sometimes, idk" })];
    const passing = await applyIntakeLint(ctx, project, issues);
    expect(passing).toEqual([]);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:ready", "fleet:needs-input");
  });
});

describe("processTicket triage claim", () => {
  function claimCtx() {
    const ctx = makeCtx();
    return ctx;
  }

  it("opens a triage session for a fleet:triage issue on a triage project", async () => {
    const ctx = claimCtx();
    const project = makeProject({ triage: true });
    await processTicket(ctx, project, makeIssue(7, ["fleet:triage"], { body: "half-formed" }));
    expect(hoisted.sessionOpts).toHaveLength(1);
    expect(hoisted.sessionOpts[0]!.kind).toBe("triage");
    expect(ctx.state.get("alpha", 7)?.isTriage).toBe(true);
  });

  it("records the claim-time body hash on a triage claim", async () => {
    const ctx = claimCtx();
    const project = makeProject({ triage: true });
    await processTicket(ctx, project, makeIssue(7, ["fleet:triage"], { body: "half-formed" }));
    expect(ctx.state.get("alpha", 7)?.bodyHashAtClaim).toBe(hashBody("half-formed"));
  });

  it("does not open a triage session when the project has triage disabled", async () => {
    const ctx = claimCtx();
    const project = makeProject({ triage: false });
    await processTicket(ctx, project, makeIssue(7, ["fleet:triage"], { body: "half-formed" }));
    expect(hoisted.sessionOpts[0]!.kind).toBe("code");
    expect(ctx.state.get("alpha", 7)?.isTriage).toBe(false);
    expect(ctx.state.get("alpha", 7)?.bodyHashAtClaim).toBeUndefined();
  });

  it("claims an issue labeled both fleet:plan and fleet:triage as a plan", async () => {
    const ctx = claimCtx();
    const project = makeProject({ triage: true });
    await processTicket(ctx, project, makeIssue(7, ["fleet:plan", "fleet:triage"], { body: "b" }));
    expect(hoisted.sessionOpts[0]!.kind).toBe("plan");
    expect(ctx.state.get("alpha", 7)?.isPlan).toBe(true);
    expect(ctx.state.get("alpha", 7)?.isTriage).toBe(false);
    expect(ctx.state.get("alpha", 7)?.bodyHashAtClaim).toBeUndefined();
  });

  it("records no body hash on an ordinary code claim", async () => {
    const ctx = claimCtx();
    const project = makeProject({ triage: true });
    await processTicket(ctx, project, makeIssue(7, ["fleet:ready"], { body: "b" }));
    expect(hoisted.sessionOpts[0]!.kind).toBe("code");
    expect(ctx.state.get("alpha", 7)?.bodyHashAtClaim).toBeUndefined();
  });
});

describe("supervise triage routing", () => {
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

  const base = { costUsd: 0, modelUsage: undefined } as never;
  const worktree = { path: "/tmp/wt/7", branch: "fleet/7" };

  it("routes a completed triage turn to finishTriaged", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
    const project = makeProject({ triage: true, confidenceThreshold: 80 });
    const issue = makeIssue(7, ["fleet:in-progress"]);
    await supervise(ctx, project, issue, worktree, fakeSession({ kind: "triage", result: RESULT }), base);
    expect(finish.finishTriaged).toHaveBeenCalledTimes(1);
    expect(vi.mocked(finish.finishTriaged).mock.calls[0]![3]).toEqual(RESULT);
    expect(finish.finishFailed).not.toHaveBeenCalled();
  });

  it("routes a blocked triage turn to finishTriaged rather than parking", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
    const project = makeProject({ triage: true });
    const blocked = { ...RESULT, status: "blocked" as const, blockedReason: "which browser?" };
    await supervise(ctx, project, makeIssue(7, []), worktree, fakeSession({ kind: "triage", result: blocked }), base);
    expect(finish.finishTriaged).toHaveBeenCalledTimes(1);
    expect(vi.mocked(finish.finishTriaged).mock.calls[0]![3]).toEqual(blocked);
  });

  it("routes an errored triage turn to finishFailed", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 7, isTriage: true }));
    const project = makeProject({ triage: true });
    const turn = { kind: "triage", errorSubtype: "invalid_structured_output" };
    await supervise(ctx, project, makeIssue(7, []), worktree, fakeSession(turn), base);
    expect(finish.finishFailed).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(finish.finishFailed).mock.calls[0]![3])).toContain("invalid_structured_output");
    expect(finish.finishTriaged).not.toHaveBeenCalled();
  });
});

describe("resuming a triage ticket", () => {
  it("keeps the session kind but never rewrites the claim-time body hash", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(
      makeRecord({ issueNumber: 7, isTriage: true, bodyHashAtClaim: "claim-time-hash", sessionId: "sess-1" }),
    );
    const project = makeProject({ triage: true });
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 7,
      title: "issue 7",
      body: "a body the human edited after the claim",
      labels: ["fleet:triage"],
      author: "collab-author",
    } as never);

    await resumeTicket(ctx, project, ctx.state.get("alpha", 7)!, "keep going");

    expect(hoisted.sessionOpts[0]!.kind).toBe("triage");
    expect(ctx.state.get("alpha", 7)?.bodyHashAtClaim).toBe("claim-time-hash");
  });

  it("keeps kind triage even once fleet:triage is no longer on the issue", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 7, isTriage: true, bodyHashAtClaim: "h", sessionId: "sess-1" }));
    const project = makeProject({ triage: true });
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 7,
      title: "issue 7",
      body: "b",
      labels: ["fleet:in-progress"],
      author: "collab-author",
    } as never);

    await resumeTicket(ctx, project, ctx.state.get("alpha", 7)!, "keep going");

    expect(hoisted.sessionOpts[0]!.kind).toBe("triage");
    expect(ctx.state.get("alpha", 7)?.isTriage).toBe(true);
  });
});
