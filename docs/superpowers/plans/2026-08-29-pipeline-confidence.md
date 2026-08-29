# Pipeline-wide Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scored fleet session reports a calibrated 0–100 confidence that is persisted as an append-only trail, displayed on the board and detail panel, and gates progress — a below-threshold score holds the ticket in `fleet:needs-input` instead of pushing, opening a PR, or filing child tickets.

**Architecture:** A single `confidenceThreshold` per project governs all five stages (triage, plan, code, machine-review, plan-review). One new module, `packages/daemon/src/loop/confidence.ts`, owns recording, the threshold comparison, the single-use `fleet:confidence-overridden` escape hatch, and the resume preamble; every call site in `supervise.ts`/`finish.ts` is two lines. Holds reuse the existing `finishBlocked` path, so no new terminal state exists. The dashboard needs no new plumbing — `BoardTicket.record` already carries the whole `TicketRecord` to both cards and the detail panel.

**Tech Stack:** TypeScript (ESM, `.ts` import extensions, no build step for backend code), zod for contracts and config, vitest, Vue 3 + Tailwind 4 for the dashboard, `gh` CLI for all GitHub mutations.

**Spec:** `docs/superpowers/specs/2026-08-29-pipeline-confidence-design.md`

---

## Required reading before starting

Read these three skills. They encode repo conventions this plan assumes:

- `.claude/skills/write-tests/SKILL.md` — fixture factories in `packages/daemon/src/test-support.ts`, mocking conventions
- `.claude/skills/config-shape-change/SKILL.md` — the four files that must change together for any config field
- `.claude/skills/add-daemon-feature/SKILL.md` — which `loop/*.test.ts` covers which behavior

Run `pnpm typecheck && pnpm test` once before starting to confirm a green baseline.

## File Structure

**Created:**
- `packages/daemon/src/loop/confidence.ts` — the whole gate: `recordConfidence`, `confidenceGate`, `confidenceHoldPreamble`, `thresholdFor`. Pure-ish functions taking `LoopContext` first, matching every other `loop/` module. No callbacks into `FleetLoop`.
- `packages/daemon/src/loop/confidence.test.ts` — unit tests for the above.
- `packages/dashboard/src/components/ConfidenceBadge.vue` — one entry rendered at two sizes; owns the color rule so it exists in exactly one place.
- `packages/dashboard/src/components/ConfidenceBadge.test.ts`

**Modified:**
- `packages/shared/src/contracts.ts` — `ConfidenceScoreSchema` + the four schema changes
- `packages/shared/src/tickets.ts` — `ConfidenceStage`, `ConfidenceEntry`, `TicketRecord.confidenceHistory`
- `packages/shared/src/config.ts` — `confidenceThreshold`, `triageAutoPromote`, removal shim
- `packages/shared/src/labels.ts` — `CONFIDENCE_OVERRIDE_LABEL`
- `packages/daemon/src/github/github.ts` — new `removeLabel`
- `packages/daemon/src/loop/supervise.ts` — code/plan gates ahead of the review gates; review-result gates
- `packages/daemon/src/loop/finish.ts` — `confidence: number`; `finishTriaged` uses the shared gate
- `packages/daemon/src/loop/runner.ts` — resume preamble
- `packages/daemon/src/session/worker.ts` — prompt instructions for code/plan/review
- `packages/daemon/src/test-support.ts` — fixture fields
- `packages/dashboard/src/components/TicketDetail.vue`, `TicketCard.vue`
- `fleet.config.example.json`, `README.md`

**Ordering rationale:** Tasks 1–4 are leaf changes with no dependencies between them beyond types. Task 5 builds the gate against those types. Tasks 6–9 wire it in, one stage per task, so a broken wiring is isolated to one commit. Tasks 10–11 are prompts and UI, independent of each other.

---

### Task 1: Confidence score schema and contract changes

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/index.test.ts`:

```ts
import { ConfidenceScoreSchema, WorkerResultSchema, MachineReviewResultSchema } from "./index.ts";

describe("ConfidenceScoreSchema", () => {
  it("accepts an integer 0-100", () => {
    expect(ConfidenceScoreSchema.parse(0)).toBe(0);
    expect(ConfidenceScoreSchema.parse(72)).toBe(72);
    expect(ConfidenceScoreSchema.parse(100)).toBe(100);
  });

  it("rejects out-of-range and non-integer numbers", () => {
    expect(ConfidenceScoreSchema.safeParse(101).success).toBe(false);
    expect(ConfidenceScoreSchema.safeParse(-1).success).toBe(false);
    expect(ConfidenceScoreSchema.safeParse(72.5).success).toBe(false);
  });

  it("coerces the legacy low/medium/high strings", () => {
    expect(ConfidenceScoreSchema.parse("low")).toBe(30);
    expect(ConfidenceScoreSchema.parse("medium")).toBe(60);
    expect(ConfidenceScoreSchema.parse("high")).toBe(90);
  });

  it("rejects any other string", () => {
    expect(ConfidenceScoreSchema.safeParse("very high").success).toBe(false);
  });
});

describe("confidence on the result contracts", () => {
  const worker = {
    status: "completed" as const,
    summary: "did the thing",
    filesChanged: ["src/a.ts"],
  };

  it("parses a numeric worker confidence", () => {
    expect(WorkerResultSchema.parse({ ...worker, confidence: 88 }).confidence).toBe(88);
  });

  it("coerces a legacy worker confidence from a pre-migration session", () => {
    expect(WorkerResultSchema.parse({ ...worker, confidence: "high" }).confidence).toBe(90);
  });

  it("requires confidence on a machine review result", () => {
    const review = { verdict: "pass" as const, summary: "looks fine" };
    expect(MachineReviewResultSchema.safeParse(review).success).toBe(false);
    expect(MachineReviewResultSchema.parse({ ...review, confidence: 80 }).confidence).toBe(80);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --root . packages/shared -t "Confidence"`
Expected: FAIL — `ConfidenceScoreSchema is not exported` / `No "ConfidenceScoreSchema" export`.

- [ ] **Step 3: Add the schema and change the four contracts**

At the top of `packages/shared/src/contracts.ts`, after the `zod` import:

```ts
/**
 * A calibrated 0-100 confidence percentage.
 *
 * TRANSITIONAL: the string arm accepts the pre-migration `low|medium|high`
 * values. This is not a rare edge case — deploying requires a daemon restart,
 * restart reconciles running tickets to `stalled`, and `recoverStalled` then
 * resumes each one into its *existing* SDK session, whose context still
 * contains the old instruction. Without this arm those sessions fail
 * `safeParse` in worker.ts, which is neither a crash nor `blocked` but an
 * errored turn — burning the ticket's once-only auto-elevate on a retry that
 * cannot succeed. Remove one full ticket-lifetime after deploy.
 */
export const ConfidenceScoreSchema = z.union([
  z.number().int().min(0).max(100),
  z.enum(["low", "medium", "high"]).transform((v) => (v === "high" ? 90 : v === "medium" ? 60 : 30)),
]);
```

In `WorkerResultSchema`, replace the `confidence` line with:

```ts
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are that the change is correct and complete. Be honest and calibrated: 90+ means you verified it end to end; below 50 means you are guessing. A score below the project threshold stops the ticket for human review instead of opening a PR, so overstating it causes real harm."),
```

In `PlanResultSchema`, replace the `confidence` line with:

```ts
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are that this decomposition is correct and complete. Be honest and calibrated. A score below the project threshold stops the epic for human review instead of filing child tickets, so overstating it causes real harm."),
```

In `MachineReviewResultSchema`, add after `findings`:

```ts
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are in this review itself — that you understood the diff and that your verdict is right. Be honest: if the diff touches code you could not fully trace, say so with a low score. A score below the project threshold stops the ticket for human review."),
```

In `PlanReviewResultSchema`, add the same field with `"...expressing how confident you are in this review of the decomposition."`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --root . packages/shared -t "Confidence" && pnpm typecheck`
Expected: PASS. Typecheck will now FAIL in `packages/daemon` on `confidence: string` — that is expected and fixed in Task 6. Note the failures and continue.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/index.test.ts
git commit -m "feat(contracts): unify confidence on a 0-100 scale across all result schemas"
```

---

### Task 2: The persisted confidence trail

**Files:**
- Modify: `packages/shared/src/tickets.ts`
- Test: none (type-only change; behavior is covered in Task 5)

- [ ] **Step 1: Add the types**

In `packages/shared/src/tickets.ts`, above `export interface TicketRecord`:

```ts
/** Every session kind that reports a confidence score. */
export type ConfidenceStage = "triage" | "plan" | "code" | "machine-review" | "plan-review";

/** One scored session, appended to `TicketRecord.confidenceHistory` and never replaced. */
export interface ConfidenceEntry {
  stage: ConfidenceStage;
  /** 0-100. */
  score: number;
  /**
   * The threshold this score was judged against, or null when the stage was
   * recorded but not gated (triage with `triageAutoPromote: false`). Stamped at
   * write time rather than looked up at render time: a Done-column card shows a
   * ticket that closed long ago, whose project may since have changed its
   * threshold or left config entirely, so the entry has to be self-describing.
   */
  threshold: number | null;
  /** Present only when a `fleet:confidence-overridden` label carried this score past its gate. */
  overridden?: true;
  at: string;
}
```

Inside `TicketRecord`, directly after the `triageConfidence` field:

```ts
  /** Append-only trail of every scored session on this ticket, oldest first. Absent on records predating this field. */
  confidenceHistory?: ConfidenceEntry[];
```

Update the `triageConfidence` doc comment to:

```ts
  /** The confidence percentage (0-100) the triage session reported. Historical only — the promote decision now comes from `confidenceHistory` via the shared gate. */
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck --filter @fleet/shared`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/tickets.ts
git commit -m "feat(tickets): add the append-only confidenceHistory trail"
```

**Note:** no SQL migration exists or is needed. The `tickets` table stores the whole record as JSON in a `data` column (`packages/daemon/src/store/db.ts:64-120`), so an optional field is purely a TypeScript change.

---

### Task 3: Config — one threshold for all five stages

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `fleet.config.example.json`
- Modify: `README.md`
- Modify: `packages/daemon/src/test-support.ts`
- Test: `packages/shared/src/index.test.ts`

Read `.claude/skills/config-shape-change/SKILL.md` first — all four files change together or `pnpm test` fails.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/index.test.ts`:

```ts
import { ProjectConfigSchema } from "./index.ts";

describe("confidence config", () => {
  const base = { name: "demo", githubRepo: "o/r", localPath: "/tmp/demo" };

  it("defaults confidenceThreshold to 70 and triageAutoPromote to true", () => {
    const parsed = ProjectConfigSchema.parse(base);
    expect(parsed.confidenceThreshold).toBe(70);
    expect(parsed.triageAutoPromote).toBe(true);
  });

  it("rejects a config still carrying the removed triageAutoPromoteThreshold", () => {
    const result = ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: 101 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("confidenceThreshold");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --root . packages/shared -t "confidence config"`
Expected: FAIL — `expected undefined to be 70`.

- [ ] **Step 3: Change the schema**

In `packages/shared/src/config.ts`, delete the `triageAutoPromoteThreshold` field and its doc comment, and put this in its place:

```ts
  /**
   * Whole-number confidence percentage every scored session must reach to
   * proceed. Governs all five stages — triage, plan, code, machine review, and
   * plan review. The comparison is `score >= threshold`, so 0 lets everything
   * through. A session below it holds the ticket in `fleet:needs-input`; the
   * operator can carry one stage past the gate with the
   * `fleet:confidence-overridden` label, which is consumed on use.
   */
  confidenceThreshold: z.number().int().min(0).max(100).default(70),
  /**
   * Whether a triage that clears `confidenceThreshold` is auto-promoted to
   * `fleet:ready`. When false, triage always holds for human review and its
   * score is recorded but not gated. Replaces the old
   * `triageAutoPromoteThreshold: 101` sentinel.
   */
  triageAutoPromote: z.boolean().default(true),
  /**
   * REMOVED — kept only to fail loudly. Zod strips unknown keys, so without
   * this a project that had set 101 (never auto-promote) would silently begin
   * promoting at the new shared default. Delete once no live config has it.
   */
  triageAutoPromoteThreshold: z
    .unknown()
    .optional()
    .refine((v) => v === undefined, {
      message:
        "`triageAutoPromoteThreshold` has been removed. Use `confidenceThreshold` (it now governs every stage, triage included), or `triageAutoPromote: false` if you had this set to 101 to never auto-promote.",
    }),
```

- [ ] **Step 4: Update the other three files**

In `fleet.config.example.json`, replace the `"triageAutoPromoteThreshold": 80` line in the project block with:

```json
      "confidenceThreshold": 70,
      "triageAutoPromote": true,
```

In `packages/daemon/src/test-support.ts`, in `makeProject`, replace `triageAutoPromoteThreshold: 80,` with:

```ts
    confidenceThreshold: 70,
    triageAutoPromote: true,
```

In `README.md`, replace the `triageAutoPromoteThreshold` row of the per-project config table with two rows:

```markdown
| `confidenceThreshold` | `70` | Score every session must reach to proceed. Governs triage, plan, code, machine review, and plan review. Below it, the ticket holds in `fleet:needs-input`; apply `fleet:confidence-overridden` to carry one stage past the gate. |
| `triageAutoPromote` | `true` | Whether a triage clearing the threshold is auto-promoted to `fleet:ready`. `false` always holds triage for human review. |
```

Also update the prose mention of `triageAutoPromoteThreshold` further down the README (search for it) to name `confidenceThreshold`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --root . packages/shared -t "confidence config"`
Expected: PASS.

Run: `grep -rn "triageAutoPromoteThreshold" packages/ README.md fleet.config.example.json`
Expected: hits only in `config.ts` (the removal shim) — everything else is gone. Task 8 removes the last daemon use.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config.ts fleet.config.example.json README.md packages/daemon/src/test-support.ts packages/shared/src/index.test.ts
git commit -m "feat(config): one confidenceThreshold for every stage, replacing triageAutoPromoteThreshold"
```

---

### Task 4: The override label and `removeLabel`

**Files:**
- Modify: `packages/shared/src/labels.ts`
- Modify: `packages/daemon/src/github/github.ts`
- Test: `packages/daemon/src/github/github.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/daemon/src/github/github.test.ts`, following the existing `addLabel` suite's mocking style:

```ts
describe("removeLabel", () => {
  it("shells out to gh issue edit with --remove-label", async () => {
    runMock.mockResolvedValue("");
    await removeLabel(makeProject(), 42, "fleet:confidence-overridden");
    expect(runMock).toHaveBeenCalledWith("gh", [
      "issue", "edit", "42",
      "--repo", "owner/repo",
      "--remove-label", "fleet:confidence-overridden",
    ]);
  });

  it("propagates a failure so callers can fail closed", async () => {
    runMock.mockRejectedValue(new Error("gh exploded"));
    await expect(removeLabel(makeProject(), 42, "fleet:confidence-overridden")).rejects.toThrow("gh exploded");
  });
});
```

Match `makeProject()`'s `githubRepo` to whatever the existing suite uses; if it isn't `owner/repo`, use the real value.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --root . packages/daemon -t "removeLabel"`
Expected: FAIL — `removeLabel is not defined`.

- [ ] **Step 3: Add the label constant**

In `packages/shared/src/labels.ts`, after `TRIAGE_LABEL`:

```ts
/** Operator escape hatch for a confidence hold. Single-use: the gate removes it as it consumes it. */
export const CONFIDENCE_OVERRIDE_LABEL = "fleet:confidence-overridden";
```

And in `ALL_FLEET_LABELS`, after the `TRIAGE_LABEL` entry:

```ts
  { name: CONFIDENCE_OVERRIDE_LABEL, color: "e99695", description: "Carry this ticket past one confidence gate — removed as soon as it is used" },
```

- [ ] **Step 4: Add `removeLabel`**

In `packages/daemon/src/github/github.ts`, directly after `addLabel`:

```ts
/**
 * Remove a label. Unlike `addLabel` there is nothing to self-heal — a label
 * that doesn't exist can't be attached — so failures propagate, which is what
 * lets the confidence gate fail closed when it can't consume an override.
 */
export async function removeLabel(project: ProjectConfig, issueNumber: number, label: string): Promise<void> {
  await run("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--remove-label", label,
  ]);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --root . packages/daemon -t "removeLabel"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/labels.ts packages/daemon/src/github/github.ts packages/daemon/src/github/github.test.ts
git commit -m "feat(labels): add fleet:confidence-overridden and a removeLabel helper"
```

---

### Task 5: The gate module

**Files:**
- Create: `packages/daemon/src/loop/confidence.ts`
- Create: `packages/daemon/src/loop/confidence.test.ts`

This is the load-bearing task. Everything after it is wiring.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/loop/confidence.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CONFIDENCE_OVERRIDE_LABEL } from "@fleet/shared";
import { makeCtx, makeProject } from "../test-support.ts";
import { confidenceGate, recordConfidence, confidenceHoldPreamble } from "./confidence.ts";

const getIssue = vi.hoisted(() => vi.fn());
const removeLabel = vi.hoisted(() => vi.fn());
vi.mock("../github/github.ts", () => ({ getIssue, removeLabel }));

beforeEach(() => {
  getIssue.mockReset().mockResolvedValue({ number: 1, title: "t", body: "", labels: [], author: "a" });
  removeLabel.mockReset().mockResolvedValue(undefined);
});

describe("recordConfidence", () => {
  it("appends without replacing and preserves order", () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    recordConfidence(ctx, "demo", 1, "triage", 88, 70);
    recordConfidence(ctx, "demo", 1, "code", 91, 70);
    const history = ctx.state.get("demo", 1)?.confidenceHistory ?? [];
    expect(history.map((e) => [e.stage, e.score])).toEqual([["triage", 88], ["code", 91]]);
  });
});

describe("confidenceGate", () => {
  it("proceeds at exactly the threshold", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    const gate = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 1, "code", 70);
    expect(gate.action).toBe("proceed");
  });

  it("holds below the threshold and records the entry anyway", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    const gate = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 1, "code", 65);
    expect(gate.action).toBe("hold");
    expect(ctx.state.get("demo", 1)?.confidenceHistory?.[0]).toMatchObject({ score: 65, threshold: 70 });
  });

  it("never holds when the threshold is null", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    const project = makeProject({ confidenceThreshold: 70, triageAutoPromote: false });
    const gate = await confidenceGate(ctx, project, 1, "triage", 5);
    expect(gate.action).toBe("proceed");
    expect(ctx.state.get("demo", 1)?.confidenceHistory?.[0]?.threshold).toBeNull();
  });

  it("consumes the override label, marks the entry, and proceeds", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    getIssue.mockResolvedValue({ number: 1, title: "t", body: "", labels: [CONFIDENCE_OVERRIDE_LABEL], author: "a" });
    const gate = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 1, "code", 40);
    expect(gate.action).toBe("proceed");
    expect(removeLabel).toHaveBeenCalledWith(expect.anything(), 1, CONFIDENCE_OVERRIDE_LABEL);
    expect(ctx.state.get("demo", 1)?.confidenceHistory?.[0]).toMatchObject({ score: 40, overridden: true });
  });

  it("holds when the override cannot be consumed, rather than proceeding", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    getIssue.mockResolvedValue({ number: 1, title: "t", body: "", labels: [CONFIDENCE_OVERRIDE_LABEL], author: "a" });
    removeLabel.mockRejectedValue(new Error("gh down"));
    const gate = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 1, "code", 40);
    expect(gate.action).toBe("hold");
  });

  it("does not apply a consumed override to a later stage", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    getIssue
      .mockResolvedValueOnce({ number: 1, title: "t", body: "", labels: [CONFIDENCE_OVERRIDE_LABEL], author: "a" })
      .mockResolvedValueOnce({ number: 1, title: "t", body: "", labels: [], author: "a" });
    const project = makeProject({ confidenceThreshold: 70 });
    expect((await confidenceGate(ctx, project, 1, "code", 40)).action).toBe("proceed");
    expect((await confidenceGate(ctx, project, 1, "machine-review", 40)).action).toBe("hold");
  });

  it("holds when the issue fetch fails, so a gh outage cannot leak a low score through", async () => {
    const ctx = makeCtx();
    ctx.state.upsert({ ...baseRecord });
    getIssue.mockRejectedValue(new Error("gh down"));
    const gate = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 1, "code", 40);
    expect(gate.action).toBe("hold");
  });
});

describe("confidenceHoldPreamble", () => {
  it("names the stage, score, and threshold when not waived", () => {
    const text = confidenceHoldPreamble({ stage: "code", score: 65, threshold: 70, at: "" }, false);
    expect(text).toContain("65%");
    expect(text).toContain("70%");
  });

  it("tells the agent to proceed when the gate was waived", () => {
    const text = confidenceHoldPreamble({ stage: "code", score: 65, threshold: 70, at: "" }, true);
    expect(text).toMatch(/waived|reviewed/i);
  });
});
```

Add this at the top of the file — `makeRecord` and `makeCtx` are both exported from `packages/daemon/src/test-support.ts` (`:83` and `:129`), and `StateStore.upsert`/`update`/`get` are the real API (`packages/daemon/src/store/state.ts:29-41`):

```ts
import { makeRecord } from "../test-support.ts";

const baseRecord = makeRecord({ project: "demo", issueNumber: 1 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --root . packages/daemon/src/loop/confidence.test.ts`
Expected: FAIL — cannot resolve `./confidence.ts`.

- [ ] **Step 3: Write the module**

Create `packages/daemon/src/loop/confidence.ts`:

```ts
import {
  CONFIDENCE_OVERRIDE_LABEL,
  type ConfidenceEntry,
  type ConfidenceStage,
  type ProjectConfig,
} from "@fleet/shared";
import { getIssue, removeLabel } from "../github/github.ts";
import { key, type LoopContext } from "./context.ts";
import { log, logError } from "../log.ts";

/**
 * The bar this stage is judged against, or null when the stage is recorded but
 * not gated. Only triage can be ungated, via `triageAutoPromote: false` — the
 * score is still worth keeping, there is just no bar it can be said to miss.
 */
export function thresholdFor(project: ProjectConfig, stage: ConfidenceStage): number | null {
  if (stage === "triage" && !project.triageAutoPromote) return null;
  return project.confidenceThreshold;
}

/** Append one scored session to the ticket's trail. Never replaces an existing entry. */
export function recordConfidence(
  ctx: LoopContext,
  projectName: string,
  issueNumber: number,
  stage: ConfidenceStage,
  score: number,
  threshold: number | null,
  overridden = false,
): ConfidenceEntry {
  const entry: ConfidenceEntry = {
    stage,
    score,
    threshold,
    ...(overridden ? { overridden: true as const } : {}),
    at: new Date().toISOString(),
  };
  const existing = ctx.state.get(projectName, issueNumber)?.confidenceHistory ?? [];
  ctx.state.update(projectName, issueNumber, { confidenceHistory: [...existing, entry] });
  return entry;
}

/**
 * Record a stage's score and decide whether it proceeds.
 *
 * Recording happens before the comparison, so a held ticket's score is on the
 * dashboard the moment it is held.
 *
 * Fails **closed** throughout, the inverse of `machineReviewGate`: a gh outage
 * or a failed label removal holds rather than proceeding. Proceeding on error
 * would let an unverified score through — and, in the override case, would
 * silently convert a single-use override into a permanent one by leaving the
 * label attached.
 */
export async function confidenceGate(
  ctx: LoopContext,
  project: ProjectConfig,
  issueNumber: number,
  stage: ConfidenceStage,
  score: number,
): Promise<{ action: "proceed" } | { action: "hold"; reason: string; entry: ConfidenceEntry }> {
  const scope = key(project.name, issueNumber);
  const threshold = thresholdFor(project, stage);

  if (threshold === null || score >= threshold) {
    recordConfidence(ctx, project.name, issueNumber, stage, score, threshold);
    return { action: "proceed" };
  }

  // Below the bar: the only way through is a human-applied override, consumed here.
  let overridden = false;
  try {
    const issue = await getIssue(project, issueNumber);
    if (issue?.labels.includes(CONFIDENCE_OVERRIDE_LABEL)) {
      // Removed *before* proceeding: if this throws we hold, because
      // proceeding with the label still attached would make the override
      // permanent for this ticket.
      await removeLabel(project, issueNumber, CONFIDENCE_OVERRIDE_LABEL);
      overridden = true;
    }
  } catch (err) {
    logError("loop", `${scope}: could not resolve the confidence override — holding`, err);
  }

  const entry = recordConfidence(ctx, project.name, issueNumber, stage, score, threshold, overridden);
  if (overridden) {
    log("loop", `${scope}: ${stage} scored ${score}% (below ${threshold}%) — carried past the gate by an operator override`);
    return { action: "proceed" };
  }

  const reason = `${stage} confidence ${score}% is below the ${threshold}% threshold`;
  log("loop", `${scope}: ${reason} — holding for human review`);
  return { action: "hold", reason, entry };
}

/**
 * Prepended to the operator's own text when a confidence-held ticket resumes.
 *
 * Without this the deadlock is unbreakable: the resumed SDK session remembers
 * *scoring* 65% but nothing tells it that the score is why it stopped, so it
 * re-does the same work and re-scores the same way. Mirrors `STALL_NUDGE` in
 * recovery.ts — a fixed preamble concatenated ahead of the operator's message,
 * never a replacement for it.
 */
export function confidenceHoldPreamble(entry: ConfidenceEntry, waived: boolean): string {
  if (waived) {
    return [
      `This ticket was held because your ${entry.stage} confidence was ${entry.score}%, below the ${entry.threshold}% threshold.`,
      "A human has reviewed the result and waived that gate for this attempt.",
      "Do not re-litigate the score or hedge into another low one: finish the work and report honestly.",
      "",
    ].join("\n");
  }
  return [
    `This ticket was held because your ${entry.stage} confidence was ${entry.score}%, below the ${entry.threshold}% threshold.`,
    "Address the specific uncertainty behind that score — verify the part you were unsure of — rather than restating work you already did.",
    "If you genuinely cannot raise your confidence, finish with status \"blocked\" and ask one specific question.",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --root . packages/daemon/src/loop/confidence.test.ts`
Expected: PASS, 9 tests.

`makeCtx(patch)` builds the `LoopContext` and takes a partial override; use it rather than inventing a fixture. For the state store, `makeTempState()` (`test-support.ts:99`) is what the other `loop/*.test.ts` files pass in when they need real persistence — follow whichever pattern `loop.supervise.test.ts` already uses.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/confidence.ts packages/daemon/src/loop/confidence.test.ts
git commit -m "feat(loop): add the confidence gate, trail recorder, and resume preamble"
```

---

### Task 6: Gate the code stage, ahead of the machine reviewer

**Files:**
- Modify: `packages/daemon/src/loop/supervise.ts:89-97`
- Modify: `packages/daemon/src/loop/finish.ts:128` (the `confidence: string` param)
- Test: `packages/daemon/src/loop/loop.supervise.test.ts` (the completed-path harness) and `packages/daemon/src/loop/loop.machinereview.test.ts` (the gate)

- [ ] **Step 1: Write the failing tests**

Read `loop.supervise.test.ts` first and copy its existing harness for driving a worker turn to `completed` — it already mocks `machineReviewGate` and `finishCompleted`. Add two cases using that same harness, changing only the turn's `confidence`:

```ts
it("holds a below-threshold completion without running the machine reviewer", async () => {
  const ctx = makeCtx();
  const project = makeProject({ confidenceThreshold: 70 });
  // Drive the harness to a completed turn with confidence: 65
  expect(machineReviewGate).not.toHaveBeenCalled();
  expect(pushBranch).not.toHaveBeenCalled();
  expect(createPullRequest).not.toHaveBeenCalled();
  expect(finishBlocked).toHaveBeenCalledWith(
    expect.anything(), project, expect.anything(),
    expect.stringContaining("below the 70% threshold"),
    expect.anything(),
  );
});

it("proceeds to the machine reviewer at or above the threshold", async () => {
  // same harness, confidence 91
  expect(machineReviewGate).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run --root . packages/daemon -t "below-threshold completion"`
Expected: FAIL — the reviewer runs and the PR is opened.

- [ ] **Step 3: Wire the gate**

In `packages/daemon/src/loop/supervise.ts`, replace the completed-code block at `:89-97`:

```ts
    if (turn.result?.status === "completed") {
      // Before the reviewer, not after: a result its own author doesn't trust
      // isn't worth a reviewer session's tokens.
      const confidence = await confidenceGate(ctx, project, issue.number, "code", turn.result.confidence);
      if (confidence.action === "hold") {
        await finishBlocked(ctx, project, issue, confidence.reason, turn.result.summary);
        return;
      }
      const gate = await machineReviewGate(ctx, project, issue, worktree, base, turn.result);
      if (gate.action === "fixing") {
        session.send(gate.prompt);
        continue;
      }
      await finishCompleted(ctx, project, issue, worktree.path, worktree.branch, turn.result.summary, turn.result);
      return;
    }
```

Add the import: `import { confidenceGate } from "./confidence.ts";`

In `packages/daemon/src/loop/finish.ts:128`, change the `result` param type:

```ts
  result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: number },
```

and the status-comment line at `:162`:

```ts
        `**Status: ready for review** (confidence: ${result.confidence}%)`,
```

Do the same for the mirrored declaration in `packages/daemon/src/loop/loop.ts:283`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run --root . packages/daemon && pnpm typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/supervise.ts packages/daemon/src/loop/finish.ts packages/daemon/src/loop/loop.ts packages/daemon/src/loop/loop.supervise.test.ts packages/daemon/src/loop/finish.test.ts
git commit -m "feat(loop): gate code completions on confidence before the machine reviewer"
```

---

### Task 7: Gate the plan, machine-review, and plan-review stages

**Files:**
- Modify: `packages/daemon/src/loop/supervise.ts` (plan completed block at `:59-67`; both review gates)
- Modify: `packages/daemon/src/loop/finish.ts:231,283` (plan status comments)
- Test: the same supervise test file

- [ ] **Step 1: Write the failing tests**

```ts
it("holds a below-threshold plan without filing child tickets", async () => {
  // plan turn resolves completed at 55%, threshold 70
  expect(planReviewGate).not.toHaveBeenCalled();
  expect(finishPlanned).not.toHaveBeenCalled();
  expect(createIssue).not.toHaveBeenCalled();
  expect(finishBlocked).toHaveBeenCalled();
});

it("holds when the machine reviewer itself reports low confidence", async () => {
  // reviewer returns { verdict: "pass", summary: "...", confidence: 40 }
  expect(pushBranch).not.toHaveBeenCalled();
  expect(finishBlocked).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(),
    expect.stringContaining("machine-review confidence 40%"),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run --root . packages/daemon -t "below-threshold plan"`
Expected: FAIL.

- [ ] **Step 3: Wire the plan gate**

In `supervise.ts`, in the plan branch, immediately before `planReviewGate`:

```ts
        const confidence = await confidenceGate(ctx, project, issue.number, "plan", turn.result.confidence);
        if (confidence.action === "hold") {
          await finishBlocked(ctx, project, issue, confidence.reason, turn.result.summary);
          return;
        }
        const gate = await planReviewGate(ctx, project, issue, worktree, base, turn.result);
```

- [ ] **Step 4: Wire the two reviewer gates**

In `machineReviewGate`, after the `isActionable` check resolves and before returning `{ action: "proceed" }` in the passed branch, gate the reviewer's own score. Change the signature's return type to include a hold, and the passed branch to:

```ts
  if (!isActionable(outcome.result)) {
    journal.append({ type: "fleet", event: "machine-review-passed", summary: outcome.result.summary });
    ctx.state.update(project.name, issue.number, { machineReviewOutcome: "passed" });
    // A review the reviewer doesn't trust is exactly when a human should look.
    // This narrowly inverts the fail-open contract: crashes, timeouts, and
    // unparseable output above still proceed — only a *completed* review
    // reporting low confidence in itself holds.
    const confidence = await confidenceGate(ctx, project, issue.number, "machine-review", outcome.result.confidence);
    if (confidence.action === "hold") return { action: "hold", reason: confidence.reason };
    log("loop", `${scope}: machine review passed`);
    return { action: "proceed" };
  }
```

Widen the return type:

```ts
): Promise<{ action: "proceed" } | { action: "fixing"; prompt: string } | { action: "hold"; reason: string }> {
```

At the call site in the completed-code block, handle the new case before the `fixing` check:

```ts
      const gate = await machineReviewGate(ctx, project, issue, worktree, base, turn.result);
      if (gate.action === "hold") {
        await finishBlocked(ctx, project, issue, gate.reason, turn.result.summary);
        return;
      }
      if (gate.action === "fixing") {
```

Apply the identical change to `planReviewGate` with stage `"plan-review"`, and handle `hold` at its call site the same way.

- [ ] **Step 5: Update the plan status comments**

In `finish.ts` at `:231` and `:283`, change both to:

```ts
        `**Status: planned** (confidence: ${result.confidence}%)`,
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm vitest run --root . packages/daemon && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/loop/supervise.ts packages/daemon/src/loop/finish.ts packages/daemon/src/loop/loop.supervise.test.ts
git commit -m "feat(loop): gate the plan and both reviewer stages on confidence"
```

---

### Task 8: Fold triage into the shared gate

**Files:**
- Modify: `packages/daemon/src/loop/finish.ts:325-390` (`finishTriaged`)
- Test: `packages/daemon/src/loop/loop.triage.test.ts` (the existing auto-promote cases live here)

- [ ] **Step 1: Write the failing tests**

Adapt the existing auto-promote tests and add:

```ts
it("holds and stamps a null threshold when triageAutoPromote is false", async () => {
  const project = makeProject({ triageAutoPromote: false, confidenceThreshold: 70 });
  await finishTriaged(ctx, project, issue, makeTriageResult({ confidence: 95 }));
  expect(swapLabel).toHaveBeenCalledWith(project, 1, "fleet:in-progress", "fleet:needs-input");
  expect(ctx.state.get("demo", 1)?.confidenceHistory?.[0]?.threshold).toBeNull();
});

it("promotes a would-be-held triage when the override label is present", async () => {
  getIssue.mockResolvedValue({ number: 1, title: "t", body: "", labels: [CONFIDENCE_OVERRIDE_LABEL], author: "a" });
  await finishTriaged(ctx, makeProject({ confidenceThreshold: 70 }), issue, makeTriageResult({ confidence: 40 }));
  expect(swapLabel).toHaveBeenCalledWith(expect.anything(), 1, "fleet:in-progress", "fleet:ready");
});

it("still holds on a body collision regardless of confidence", async () => {
  // appendTriageSpecSafely returns "commented"
  await finishTriaged(ctx, makeProject(), issue, makeTriageResult({ confidence: 99 }));
  expect(swapLabel).toHaveBeenCalledWith(expect.anything(), 1, "fleet:in-progress", "fleet:needs-input");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run --root . packages/daemon -t "triageAutoPromote is false"`
Expected: FAIL — `triageAutoPromote` is not read anywhere yet.

- [ ] **Step 3: Replace the inline comparison**

In `finishTriaged`, replace the `promote` and `held` block with:

```ts
  // The collision and blocked checks short-circuit *before* the gate: neither
  // is a confidence question, and both fail closed on their own.
  const blocker =
    written === "commented"
      ? "the issue body was edited while triage was running"
      : result.status === "blocked"
        ? `triage is blocked: ${result.blockedReason ?? "no reason given"}`
        : null;

  let promote = false;
  let held = blocker;
  if (blocker === null) {
    const gate = await confidenceGate(ctx, project, issue.number, "triage", result.confidence);
    promote = gate.action === "proceed";
    held = gate.action === "hold" ? gate.reason : null;
  } else {
    // Record the score even when a non-confidence blocker holds the ticket, so
    // the trail shows what triage actually reported.
    recordConfidence(ctx, project.name, issue.number, "triage", result.confidence, thresholdFor(project, "triage"));
  }
```

Update the status-comment line that referenced the old threshold:

```ts
      promote
        ? "Promoted to `fleet:ready` — a coding worker will claim it on a later cycle."
        : `Held for review — ${held}.`,
```

(unchanged, but `held` is now `string | null`; use `held ?? "confidence gate"` if the type complains).

Add imports: `import { confidenceGate, recordConfidence, thresholdFor } from "./confidence.ts";`

Leave the `triageConfidence` write at the top of the function exactly as it is.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run --root . packages/daemon && pnpm typecheck`
Expected: PASS.

Run: `grep -rn "triageAutoPromoteThreshold" packages/daemon/`
Expected: no hits.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/finish.ts packages/daemon/src/loop/loop.triage.test.ts
git commit -m "feat(loop): route triage promotion through the shared confidence gate"
```

---

### Task 9: Feed the hold reason back on resume

**Files:**
- Modify: `packages/daemon/src/loop/runner.ts:222-279` (`resumeTicket`)
- Test: `packages/daemon/src/loop/loop.triage.test.ts` and `packages/daemon/src/loop/loop.comments.test.ts` both drive `resumeTicket`; add these cases to `loop.comments.test.ts`, which already asserts on the message passed through

- [ ] **Step 1: Write the failing test**

```ts
it("prepends the confidence hold preamble to the operator's message", async () => {
  ctx.state.upsert({ ...record, confidenceHistory: [{ stage: "code", score: 65, threshold: 70, at: "2026-08-29T00:00:00Z" }], status: "needs-input" });
  await resumeTicket(ctx, project, ctx.state.get("demo", 1)!, "looks fine to me, go ahead");
  const firstMessage = runSession.mock.calls[0][1].firstMessage;
  expect(firstMessage).toContain("65%");
  expect(firstMessage).toContain("looks fine to me, go ahead");
});

it("sends the operator's message unchanged when the last entry passed its gate", async () => {
  ctx.state.upsert({ ...record, confidenceHistory: [{ stage: "code", score: 91, threshold: 70, at: "2026-08-29T00:00:00Z" }], status: "needs-input" });
  await resumeTicket(ctx, project, ctx.state.get("demo", 1)!, "one more thing");
  expect(runSession.mock.calls[0][1].firstMessage).toBe("one more thing");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run --root . packages/daemon -t "confidence hold preamble"`
Expected: FAIL — the message is passed through verbatim.

- [ ] **Step 3: Prepend the preamble**

In `resumeTicket`, just before the `runSession` call:

```ts
    // A confidence hold is the one resume where the operator's text alone is
    // not enough context: the session remembers its score but not that the
    // score is why it stopped.
    const lastEntry = record.confidenceHistory?.at(-1);
    const heldOnConfidence =
      lastEntry !== undefined && lastEntry.threshold !== null && lastEntry.score < lastEntry.threshold;
    const firstMessage = heldOnConfidence
      ? confidenceHoldPreamble(lastEntry, lastEntry.overridden === true) + message
      : message;
```

and pass `firstMessage` instead of `message` to `runSession`.

Add: `import { confidenceHoldPreamble } from "./confidence.ts";`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run --root . packages/daemon && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/runner.ts packages/daemon/src/loop/loop.comments.test.ts
git commit -m "feat(loop): tell a resumed session why its confidence hold happened"
```

---

### Task 10: Ask every session for a calibrated score

**Files:**
- Modify: `packages/daemon/src/session/worker.ts` (`WORKER_CONTRACT`, `PLANNER_CONTRACT`)
- Modify: `packages/daemon/src/session/review.ts` (the reviewer prompt builders)
- Test: the existing `buildSystemPromptAppend` tests

- [ ] **Step 1: Write the failing test**

```ts
it("asks a code session for a calibrated confidence percentage", () => {
  expect(buildSystemPromptAppend("code")).toContain("calibrated confidence percentage");
});

it("asks a plan session for one too", () => {
  expect(buildSystemPromptAppend("plan")).toContain("calibrated confidence percentage");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run --root . packages/daemon -t "calibrated confidence"`
Expected: FAIL.

- [ ] **Step 3: Add the instruction**

Add as the last bullet of `WORKER_CONTRACT`:

```
- Report a calibrated confidence percentage (0-100). A score below the project's threshold stops this ticket for human review instead of opening a PR, so an overstated number wastes a human's time on work you knew was shaky — and an understated one stops work that was fine. 90+ means you verified the change end to end; below 50 means you are guessing.
```

Add as the last bullet of `PLANNER_CONTRACT`:

```
- Report a calibrated confidence percentage (0-100) for the decomposition as a whole. A score below the project's threshold stops the epic for human review instead of filing the child tickets, so be honest: 90+ means every child is genuinely self-contained and correctly scoped; below 50 means you are unsure the epic decomposes this way at all.
```

In `packages/daemon/src/session/review.ts`, add to both `buildMachineReviewPrompt` and the plan-review prompt builder:

```
- Report a calibrated confidence percentage (0-100) in this review itself — not in the code, but in your reading of it. If the diff touches code you could not fully trace, say so with a low score; a review below the project's threshold stops the ticket for a human rather than passing it on.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run --root . packages/daemon -t "calibrated confidence"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session/worker.ts packages/daemon/src/session/review.ts packages/daemon/src/session/*.test.ts
git commit -m "feat(prompts): ask code, plan, and review sessions for a calibrated score"
```

---

### Task 11: Show it on the board and in the detail panel

**Files:**
- Create: `packages/dashboard/src/components/ConfidenceBadge.vue`
- Create: `packages/dashboard/src/components/ConfidenceBadge.test.ts`
- Modify: `packages/dashboard/src/components/TicketDetail.vue:306`
- Modify: `packages/dashboard/src/components/TicketCard.vue:91-92`

No API changes: `getBoard` attaches the whole `TicketRecord` to active tickets and `synthesizeDoneTickets` attaches the `ClosedTicketRecord` (which extends it) to Done ones, so `ticket.record?.confidenceHistory` is already available on every surface.

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/components/ConfidenceBadge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ConfidenceBadge from "./ConfidenceBadge.vue";

const entry = (patch = {}) => ({ stage: "code" as const, score: 91, threshold: 70, at: "", ...patch });

describe("ConfidenceBadge", () => {
  it("renders the score as a percentage", () => {
    expect(mount(ConfidenceBadge, { props: { entry: entry() } }).text()).toContain("91%");
  });

  it("is green at or above the threshold, including the boundary", () => {
    expect(mount(ConfidenceBadge, { props: { entry: entry({ score: 70 }) } }).html()).toContain("emerald");
  });

  it("is red below the threshold", () => {
    expect(mount(ConfidenceBadge, { props: { entry: entry({ score: 65 }) } }).html()).toContain("rose");
  });

  it("is neutral when the threshold is null", () => {
    expect(mount(ConfidenceBadge, { props: { entry: entry({ threshold: null, score: 5 }) } }).html()).toContain("slate");
  });

  it("shows the stage when asked", () => {
    expect(mount(ConfidenceBadge, { props: { entry: entry(), showStage: true } }).text()).toContain("Code");
  });

  it("marks an overridden entry as green even below the threshold", () => {
    const html = mount(ConfidenceBadge, { props: { entry: entry({ score: 40, overridden: true }) } }).html();
    expect(html).toContain("emerald");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run --root . packages/dashboard -t "ConfidenceBadge"`
Expected: FAIL — cannot resolve `./ConfidenceBadge.vue`.

- [ ] **Step 3: Write the component**

Create `packages/dashboard/src/components/ConfidenceBadge.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { ConfidenceEntry } from "@fleet/shared";

const props = defineProps<{ entry: ConfidenceEntry; showStage?: boolean }>();

const STAGE_LABELS: Record<ConfidenceEntry["stage"], string> = {
  triage: "Triage",
  plan: "Plan",
  code: "Code",
  "machine-review": "Review",
  "plan-review": "Plan review",
};

/** Neutral when the stage was recorded but not gated — there is no bar it can be said to have missed. */
const tone = computed(() => {
  const { threshold, score, overridden } = props.entry;
  if (threshold === null) return "bg-slate-500/15 text-slate-300 ring-slate-500/30";
  if (overridden || score >= threshold) return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30";
  return "bg-rose-500/15 text-rose-300 ring-rose-500/30";
});

const title = computed(() =>
  props.entry.threshold === null
    ? `${STAGE_LABELS[props.entry.stage]} confidence ${props.entry.score}% (not gated)`
    : `${STAGE_LABELS[props.entry.stage]} confidence ${props.entry.score}% against a ${props.entry.threshold}% threshold${props.entry.overridden ? " — carried past the gate by an operator override" : ""}`,
);
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
    :class="tone"
    :title="title"
  >
    <span v-if="showStage">{{ STAGE_LABELS[entry.stage] }}</span>
    <span>{{ entry.score }}%</span>
    <span v-if="entry.overridden" aria-label="operator override">&#9873;</span>
  </span>
</template>
```

Match the existing Tailwind idiom in `TicketCard.vue` — if the dashboard uses solid colors rather than `/15` alpha ring styles, follow that instead and update the test's expected class substrings.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run --root . packages/dashboard -t "ConfidenceBadge"`
Expected: PASS.

- [ ] **Step 5: Add it to the detail panel**

In `TicketDetail.vue`, import the badge and add above the meta row at `:306`:

```vue
<div v-if="confidenceTrail.length > 0" class="mb-2">
  <button type="button" class="flex items-center gap-2" @click="showTrail = !showTrail">
    <ConfidenceBadge :entry="confidenceTrail[confidenceTrail.length - 1]" show-stage />
    <span v-if="confidenceTrail.length > 1" class="text-xs text-slate-400">{{ showTrail ? "hide" : "history" }}</span>
  </button>
  <div v-if="showTrail" class="mt-2 flex flex-wrap items-center gap-1">
    <template v-for="(e, i) in confidenceTrail" :key="e.at">
      <span v-if="i > 0" class="text-xs text-slate-500">&rarr;</span>
      <ConfidenceBadge :entry="e" show-stage />
    </template>
  </div>
</div>
```

with, in the `<script setup>`:

```ts
const showTrail = ref(false);
// Render exactly the entries present, in order. There are no slots for absent
// stages: most tickets never pass through all five, and a ticket mid-flight
// during the rollout has a `code` entry with no `triage` or `plan` before it.
const confidenceTrail = computed(() => props.ticket.record?.confidenceHistory ?? []);
```

- [ ] **Step 6: Add it to the card**

In `TicketCard.vue`, next to the triage badge at `:91-92`:

```vue
<ConfidenceBadge v-if="latestConfidence" :entry="latestConfidence" />
```

with:

```ts
const latestConfidence = computed(() => props.ticket.record?.confidenceHistory?.at(-1));
```

- [ ] **Step 7: Verify both surfaces**

Run: `pnpm vitest run --root . packages/dashboard && pnpm typecheck && pnpm build`
Expected: PASS all three.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/components/
git commit -m "feat(dashboard): show confidence on ticket cards and the detail panel"
```

---

### Task 12: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS all three.

- [ ] **Step 2: Dry-run the daemon**

Run: `pnpm daemon -- --dry-run --once`
Expected: a clean poll cycle, no config error. If it errors on `triageAutoPromoteThreshold`, your local `fleet.config.json` still has the field — that is the removal shim from Task 3 working correctly. Replace it with `confidenceThreshold` (and `triageAutoPromote: false` if it was 101).

- [ ] **Step 3: Confirm the label lands**

Run: `pnpm daemon init-labels`
Expected: `fleet:confidence-overridden` created in each configured repo.

- [ ] **Step 4: Read `.claude/skills/verify/SKILL.md` and run anything it lists that this plan missed.**

- [ ] **Step 5: Commit any fixes, then push**

```bash
git push fork design/fleet-triage
```

---

## Post-merge follow-up

Delete the transitional string arm of `ConfidenceScoreSchema` and its test once no resumable session predates the change — one full ticket lifetime after deploy. Leaving it is not harmful, but it silently accepts output from a prompt that no longer exists, which will confuse the next reader.

Delete the `triageAutoPromoteThreshold` removal shim from `ProjectConfigSchema` on the same schedule, once every live `fleet.config.json` has been migrated.
