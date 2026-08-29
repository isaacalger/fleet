# Fleet Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let fleet surface GitHub issues that carry no `fleet:*` label, investigate one on request with a read-only debugging session, and auto-promote the resulting spec to `fleet:ready` when the agent's confidence meets a configurable percentage.

**Architecture:** A third session kind, `"triage"`, joins `"code"` and `"plan"` in the existing claim → run → supervise → finish pipeline. Triage is triggered by a new `fleet:triage` label, so it inherits claiming, budgets, recovery, and the usage-limit pause for free. Its structured output carries a root cause, evidence, an integer confidence percentage, and a three-section spec. The terminal path writes that spec into the issue body — but only if the body is byte-identical to what the session was claimed against — then promotes or holds.

**Tech Stack:** TypeScript (ESM, `.ts` import extensions, run via `tsx`, never compiled), zod v4 (`z.toJSONSchema`), Hono, Vue 3 + Tailwind 4, vitest, `node:sqlite`, `gh` CLI for all GitHub access.

**Spec:** `docs/superpowers/specs/2026-08-28-fleet-triage-design.md`

---

## Conventions you must follow

Read these before Task 1. They are not optional and they are not obvious from the code you will be editing.

- **ESM with explicit extensions.** Every relative import ends in `.ts` — `import { foo } from "./bar.ts"`. Node built-ins are `node:*`. There is no build step for backend code.
- **Never import a shared concern module directly.** Use `@fleet/shared`, never `@fleet/shared/src/contracts.ts`. The barrel is `packages/shared/src/index.ts`; if you add an export, it must be re-exported there.
- **All GitHub mutations go through `packages/daemon/src/github/github.ts`.** Never shell out to `gh` from anywhere else. That file uses `run()` from `github/exec.ts`.
- **Tests are colocated** with their subject: `loop/loop.triage.test.ts` sits next to `loop/finish.ts`. Name loop behavior tests `loop.<behavior>.test.ts`.
- **Run tests with `pnpm test`** from the repo root (turbo-cached). A single file: `pnpm vitest run packages/daemon/src/loop/loop.triage.test.ts`.
- **Node ≥24 is required to run the daemon** (`node:sqlite`). On this machine node 22 is the nvm default and node 24 is at `/usr/local/bin/node`; `nvm use 24` before running anything. Note that `pnpm install` currently crashes under node 24.4.1 — install under 22, run under 24.
- **Commit after every task.** Conventional commit messages.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `packages/daemon/src/loop/triage.ts` | `renderTriageSpec` — turn a `TriageResult` into issue-body markdown. Kept out of `finish.ts` so the pure formatting is unit-testable alone. |
| `packages/daemon/src/loop/loop.triage.test.ts` | All triage claim/promote/hold/collision behavior. |
| `packages/daemon/src/github/github.triage.test.ts` | `hashBody`, `createIssueComment`, `appendTriageSpecSafely`. |
| `packages/daemon/src/server/server.triage.test.ts` | The two new REST routes. |
| `packages/dashboard/src/components/TriagePanel.vue` | The Triage section listing non-fleet issues with an Investigate button. |
| `packages/dashboard/src/components/TriagePanel.test.ts` | Component test. |
| `templates/systematic-debugging/SKILL.md` | Vendored copy of the superpowers skill, stamped into target repos. |

**Modify:**

| Path | Change |
|---|---|
| `packages/shared/src/contracts.ts` | Add `TriageResultSchema`. |
| `packages/shared/src/labels.ts` | Add `TRIAGE_LABEL` and an `ALL_FLEET_LABELS` entry. |
| `packages/shared/src/config.ts` | Add `triage`, `triageAutoPromoteThreshold` to `ProjectConfigSchema`. |
| `packages/shared/src/tickets.ts` | Add `isTriage`, `bodyHashAtClaim`, `triageConfidence` to `TicketRecord`. |
| `packages/daemon/src/github/github.ts` | Add `hashBody`, `createIssueComment`, `appendTriageSpecSafely`, `listOpenIssues`; refactor `listFleetIssues` onto it. |
| `packages/daemon/src/session/worker.ts` | `SessionKind` gains `"triage"`; `TRIAGE_CONTRACT`, `TRIAGE_OUTPUT_SCHEMA`, `TriageTurnResult`, result parsing, read-only hook. |
| `packages/daemon/src/loop/claim.ts` | Detect `fleet:triage`, capture `bodyHashAtClaim`, pass `kind: "triage"`. |
| `packages/daemon/src/loop/runner.ts` | Same on the resume path. |
| `packages/daemon/src/loop/supervise.ts` | Dispatch `turn.kind === "triage"`. |
| `packages/daemon/src/loop/finish.ts` | Add `finishTriaged`. |
| `packages/daemon/src/server/server.ts` | `GET /api/triage`, `POST /api/triage/:project/:issue/investigate`. |
| `packages/daemon/src/sync-templates.ts` | Stamp the vendored skill. |
| `packages/dashboard/src/App.vue` | Mount `TriagePanel`. |
| `fleet.config.example.json` | The two new project fields. |
| `README.md` | Config prose + a Triage section. |

---

## Task 1: `TriageResultSchema` contract

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/contracts.test.ts`
Expected: FAIL — `TriageResultSchema` is not exported from `./contracts.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/contracts.ts`:

```ts
export const TriageResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = a root cause was identified and a spec is ready; blocked = a human decision is needed before triage can proceed"),
  summary: z.string().describe("2-5 sentence plain-language summary of the investigation, written for the issue's status comment"),
  rootCause: z.string().describe("The underlying defect you identified — what is actually wrong in the code, not the symptom the reporter observed. Required even at low confidence; say what you believe and let the confidence score carry your uncertainty."),
  evidence: z.array(z.string()).default([]).describe("Repo-relative `file:line` references that support the diagnosis, e.g. `src/storage.js:8`"),
  confidence: z.number().int().min(0).max(100).describe("Whole-number percentage (0-100) expressing how confident you are that rootCause is correct and the spec below is implementable as written. Be honest and calibrated: 90+ means you traced the defect to specific lines and understand the fix; below 50 means you are guessing. This number gates whether the spec is auto-promoted to a coding worker without human review, so overstating it causes real harm."),
  spec: z.object({
    problem: z.string().describe("Markdown for the issue body's `## Problem` section — a self-contained statement of the defect"),
    acceptanceCriteria: z.string().describe("Markdown for the `## Acceptance criteria` section — checkable conditions, one per line"),
    verification: z.string().describe("Markdown for the `## Verification` section — the exact commands and manual steps that prove the fix"),
  }).describe("A self-contained spec a coding agent could implement with no other context"),
  suggestedTier: z.enum(["light", "standard", "elevated"]).optional().describe("Suggested model tier for the follow-on coding ticket: light = mechanical/small-surface, elevated = cross-cutting or design-heavy, standard = everything else (default)"),
  blockedReason: z.string().optional().describe("The specific question or decision a human must answer (required when status is blocked)"),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/contracts.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the barrel re-exports it**

`packages/shared/src/index.ts` re-exports `./contracts.ts` wholesale. Verify:

Run: `grep -n "contracts" packages/shared/src/index.ts`
Expected: a `export * from "./contracts.ts";` line. If it names exports individually instead, add `TriageResultSchema` and `TriageResult` to that list.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): add TriageResultSchema contract"
```

---

## Task 2: The `fleet:triage` label

**Files:**
- Modify: `packages/shared/src/labels.ts`
- Test: `packages/shared/src/labels.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ALL_FLEET_LABELS, TRIAGE_LABEL, boardStatusFromLabels } from "./labels.ts";

describe("TRIAGE_LABEL", () => {
  it("is fleet:triage", () => {
    expect(TRIAGE_LABEL).toBe("fleet:triage");
  });

  it("is included in ALL_FLEET_LABELS so init-labels creates it", () => {
    expect(ALL_FLEET_LABELS.map((l) => l.name)).toContain("fleet:triage");
  });

  it("maps to no board status — triage issues are not board tickets", () => {
    expect(boardStatusFromLabels(["fleet:triage"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/labels.test.ts`
Expected: FAIL — `TRIAGE_LABEL` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/labels.ts`, after the `PLAN_LABEL` declaration:

```ts
export const TRIAGE_LABEL = "fleet:triage";
```

And add to the `ALL_FLEET_LABELS` array, after the `PLAN_LABEL` entry:

```ts
  { name: TRIAGE_LABEL, color: "fbca04", description: "Investigate this issue with a read-only triage session and produce a spec" },
```

Do **not** touch `boardStatusFromLabels` — it returns `null` for unrecognized labels already, which is the behavior the third test asserts.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/labels.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/labels.ts packages/shared/src/labels.test.ts
git commit -m "feat(shared): add fleet:triage label"
```

---

## Task 3: Config fields

**REQUIRED SUB-SKILL:** invoke the `config-shape-change` skill before starting. Three places must change together or `pnpm test` fails.

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `fleet.config.example.json`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/config.test.ts`:

```ts
describe("triage config", () => {
  it("defaults triage off and the threshold to 80", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p", repoPath: "/tmp/p", githubRepo: "o/p",
    });
    expect(parsed.triage).toBe(false);
    expect(parsed.triageAutoPromoteThreshold).toBe(80);
  });

  it("accepts 101 as the never-auto-promote sentinel", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p", repoPath: "/tmp/p", githubRepo: "o/p", triageAutoPromoteThreshold: 101,
    });
    expect(parsed.triageAutoPromoteThreshold).toBe(101);
  });

  it("rejects a threshold above 101 or below 0", () => {
    const base = { name: "p", repoPath: "/tmp/p", githubRepo: "o/p" };
    expect(ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: 102 }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: -1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/config.test.ts`
Expected: FAIL — `parsed.triage` is `undefined`.

- [ ] **Step 3: Add the schema fields**

In `packages/shared/src/config.ts`, inside `ProjectConfigSchema`, next to `machineReview`:

```ts
  /** Enable the triage stage for this project — the Triage panel's Investigate button and `fleet:triage` claiming. */
  triage: z.boolean().default(false),
  /**
   * Whole-number confidence percentage at or above which a completed triage is
   * auto-promoted to `fleet:ready`. The comparison is `confidence >= threshold`,
   * so 0 promotes everything and 101 — above any reportable confidence — never
   * promotes, leaving triage as a pure spec-writing step.
   */
  triageAutoPromoteThreshold: z.number().int().min(0).max(101).default(80),
```

- [ ] **Step 4: Add to `fleet.config.example.json`**

`packages/shared/src/example-config.test.ts` asserts every key in `ProjectConfigSchema.shape` appears in the example file. Inside the single `projects[0]` object, after `"machineReview": true,`:

```json
      "triage": true,
      "triageAutoPromoteThreshold": 80,
```

- [ ] **Step 5: Add to `README.md`**

In the `## Config` section, in the per-project paragraph, after the `machineReview` clause, insert:

```
`triage` (default off — enable the Triage panel and `fleet:triage` claiming for this project), `triageAutoPromoteThreshold` (default 80 — the whole-number confidence percentage at or above which a completed triage is auto-promoted to `fleet:ready`; 101 never auto-promotes),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — in particular `config.test.ts` and `example-config.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/config.test.ts fleet.config.example.json README.md
git commit -m "feat(config): add triage and triageAutoPromoteThreshold"
```

---

## Task 4: `TicketRecord` fields

**Files:**
- Modify: `packages/shared/src/tickets.ts`
- Modify: `packages/daemon/src/store/db.ts`
- Test: `packages/daemon/src/store/state.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/src/store/state.test.ts`:

```ts
it("round-trips triage fields", () => {
  const { state } = makeTempState();
  state.upsert(makeRecord({
    project: "p", issueNumber: 7,
    isTriage: true,
    bodyHashAtClaim: "a".repeat(64),
    triageConfidence: 85,
  }));
  const read = state.get("p", 7);
  expect(read?.isTriage).toBe(true);
  expect(read?.bodyHashAtClaim).toBe("a".repeat(64));
  expect(read?.triageConfidence).toBe(85);
});
```

Import `makeRecord` and `makeTempState` from `../test-support.ts` if the file does not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/store/state.test.ts`
Expected: FAIL — TypeScript rejects the unknown properties, or the read values are `undefined`.

- [ ] **Step 3: Add the type fields**

In `packages/shared/src/tickets.ts`, in `TicketRecord`, next to `isPlan`:

```ts
  /** True when this ticket was claimed from a `fleet:triage` label — a read-only investigation, not a coding run. */
  isTriage?: boolean;
  /** SHA-256 of the issue body as it stood when the triage session opened, used to detect concurrent human edits at finish time. */
  bodyHashAtClaim?: string;
  /** The confidence percentage (0-100) the triage session reported, kept so the threshold can be tuned against observed outcomes. */
  triageConfidence?: number;
```

- [ ] **Step 4: Add the columns and migration**

**No `store/db.ts` change is needed.** The `tickets` table is:

```sql
CREATE TABLE IF NOT EXISTS tickets (
  project TEXT NOT NULL, issue_number INTEGER NOT NULL,
  status TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (project, issue_number)
);
```

`upsertTicket` writes `JSON.stringify(record)` into `data`; `getTicket` parses it back. `project`, `issue_number`, and `status` are duplicated out purely as index keys. There are no per-field columns, no `ALTER TABLE` migrations, and no `is_plan` column — `isPlan` lives inside the JSON blob like everything else.

So adding optional fields to `TicketRecord` is inherently backward-compatible: old rows simply lack the keys and read back as `undefined`. Booleans survive the JSON round-trip as real booleans, so `state.get()` returns `true`, not `1`.

Corollary for later tasks: **triage tickets are not queryable in SQL.** Anything that needs "all triage tickets" reads through the existing all-tickets accessor and filters in JS.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/store/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the migration is safe against an existing database**

Run: `pnpm test`
Expected: PASS. The migration tests in `store/` exercise opening an older schema; a non-idempotent `ADD COLUMN` fails there.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/tickets.ts packages/daemon/src/store/db.ts packages/daemon/src/store/state.test.ts
git commit -m "feat(store): persist triage fields on TicketRecord"
```

---

## Task 5: GitHub helpers — hashing, comments, safe append

**Files:**
- Modify: `packages/daemon/src/github/github.ts`
- Test: `packages/daemon/src/github/github.triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/github/github.triage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";

vi.mock("./exec.ts", () => ({
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
  runJson: vi.fn(async () => ({})),
}));

const exec = await import("./exec.ts");
const { appendTriageSpecSafely, hashBody, createIssueComment } = await import("./github.ts");

const project = makeProject();
const SPEC = "## Problem\nBroken.\n\n## Acceptance criteria\n- Fixed\n\n## Verification\nnpm test";

beforeEach(() => vi.clearAllMocks());

describe("hashBody", () => {
  it("is stable and differs on any change", () => {
    expect(hashBody("abc")).toBe(hashBody("abc"));
    expect(hashBody("abc")).not.toBe(hashBody("abd"));
  });

  it("returns a 64-char hex sha256", () => {
    expect(hashBody("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createIssueComment", () => {
  it("posts a new comment rather than editing an existing one", async () => {
    await createIssueComment(project, 7, "hello");
    const args = vi.mocked(exec.run).mock.calls[0][1];
    expect(args).toContain("comment");
    expect(args).not.toContain("PATCH");
  });
});

describe("appendTriageSpecSafely", () => {
  it("appends to the body when the hash is unchanged", async () => {
    const body = "Original body";
    vi.mocked(exec.runJson).mockResolvedValue({ number: 7, title: "t", body, labels: [] });

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody(body));

    expect(outcome).toBe("appended");
    const stdins = vi.mocked(exec.run).mock.calls.map((c) => c[2]?.stdin);
    expect(stdins.some((s) => s?.includes("Original body") && s?.includes("## Problem"))).toBe(true);
  });

  it("comments instead of editing when the body changed mid-run", async () => {
    vi.mocked(exec.runJson).mockResolvedValue({ number: 7, title: "t", body: "EDITED by a human", labels: [] });

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody("Original body"));

    expect(outcome).toBe("commented");
    const calls = vi.mocked(exec.run).mock.calls;
    expect(calls.every((c) => !c[1].includes("--body-file") || !c[1].includes("edit"))).toBe(true);
    expect(calls.some((c) => c[2]?.stdin?.includes("Concurrent edit detected"))).toBe(true);
    expect(calls.some((c) => c[2]?.stdin?.includes("## Problem"))).toBe(true);
  });

  it("fails closed when the issue cannot be fetched", async () => {
    vi.mocked(exec.runJson).mockRejectedValue(new Error("gh exploded"));

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody("Original body"));

    expect(outcome).toBe("commented");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/github/github.triage.test.ts`
Expected: FAIL — `appendTriageSpecSafely` is not exported.

- [ ] **Step 3: Write the implementation**

At the top of `packages/daemon/src/github/github.ts`, add to the imports:

```ts
import { createHash } from "node:crypto";
```

Append these three functions:

```ts
/** SHA-256 of an issue body, used to detect a concurrent human edit during a triage session. */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Posts a new, permanent issue comment. Distinct from `upsertStatusComment`,
 * which maintains the single continuously-overwritten status comment — anything
 * written there is destroyed by the next status update or heartbeat refresh.
 */
export async function createIssueComment(project: ProjectConfig, issueNumber: number, body: string): Promise<void> {
  await run("gh", [
    "issue", "comment", String(issueNumber),
    "--repo", project.githubRepo,
    "--body-file", "-",
  ], { stdin: clampBody(body) });
}

/**
 * Appends a triage spec to the issue body, but only when the body is
 * byte-identical to what the session was claimed against. A human edit mid-run
 * makes the agent's premise stale, so the spec is preserved as a standalone
 * comment instead and the caller forces `fleet:needs-input` regardless of
 * confidence.
 *
 * Detection compares a body hash rather than `updatedAt` deliberately: fleet's
 * own label swaps, status-comment upserts, and heartbeat refreshes all bump
 * `updatedAt` during a normal run, so a timestamp check would report a collision
 * on essentially every triage and make auto-promotion dead code.
 */
export async function appendTriageSpecSafely(
  project: ProjectConfig,
  issueNumber: number,
  spec: string,
  bodyHashAtClaim: string,
): Promise<"appended" | "commented"> {
  const current = await getIssue(project, issueNumber);
  if (!current) {
    log("github", `triage #${issueNumber}: could not re-read the issue before appending — preserving the spec as a comment`);
    await createIssueComment(project, issueNumber, collisionComment(spec));
    return "commented";
  }

  if (hashBody(current.body) !== bodyHashAtClaim) {
    await createIssueComment(project, issueNumber, collisionComment(spec));
    return "commented";
  }

  await updateIssueBody(project, issueNumber, `${current.body}\n\n${spec}`);
  return "appended";
}

function collisionComment(spec: string): string {
  return [
    "⚠️ **Concurrent edit detected.**",
    "",
    "The issue body changed while triage was investigating, so the diagnosis may rest on a stale premise.",
    "The proposed spec is preserved here rather than written into the body:",
    "",
    spec,
  ].join("\n");
}
```

`getIssue` already returns `undefined` on any fetch failure, so the rejected-`runJson` case in the test lands on the first branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/github/github.triage.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/github/github.ts packages/daemon/src/github/github.triage.test.ts
git commit -m "feat(github): add hashBody, createIssueComment, appendTriageSpecSafely"
```

---

## Task 6: Split `listFleetIssues` to expose non-fleet issues

**Files:**
- Modify: `packages/daemon/src/github/github.ts:79`
- Test: `packages/daemon/src/github/github.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/src/github/github.test.ts` (follow the mocking already used in that file; if it mocks `./exec.ts`, reuse that setup):

```ts
describe("listNonFleetIssues", () => {
  const RAW = [
    { number: 1, title: "fleet one", body: "", labels: [{ name: "fleet:ready" }], url: "u1", author: { login: "a" }, assignees: [] },
    { number: 2, title: "plain bug", body: "b", labels: [{ name: "bug" }], url: "u2", author: { login: "a" }, assignees: [] },
    { number: 3, title: "unlabeled", body: "", labels: [], url: "u3", author: { login: "a" }, assignees: [] },
  ];

  it("returns only issues with no fleet:* label", async () => {
    vi.mocked(exec.runJson).mockResolvedValue(RAW);
    const issues = await listNonFleetIssues(makeProject());
    expect(issues.map((i) => i.number)).toEqual([2, 3]);
  });

  it("is the exact complement of listFleetIssues over the same fetch", async () => {
    vi.mocked(exec.runJson).mockResolvedValue(RAW);
    const fleet = await listFleetIssues(makeProject());
    vi.mocked(exec.runJson).mockResolvedValue(RAW);
    const nonFleet = await listNonFleetIssues(makeProject());
    expect(fleet.length + nonFleet.length).toBe(RAW.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/github/github.test.ts`
Expected: FAIL — `listNonFleetIssues` is not exported.

- [ ] **Step 3: Refactor**

Replace the body of `listFleetIssues` (`github.ts:79`) with a shared fetch plus two filters. The existing sort and the 1000-issue truncation warning stay on the fleet path exactly as they are:

```ts
/** Every open issue, mapped to `FleetIssue` shape and unfiltered. One `gh` call, shared by both views below. */
async function listOpenIssues(project: ProjectConfig): Promise<FleetIssue[]> {
  const issues = await runJson<GhIssueJson[]>("gh", [
    "issue", "list",
    "--repo", project.githubRepo,
    "--state", "open",
    "--json", "number,title,body,labels,url,author,assignees",
    "--limit", "1000",
  ]);
  if (issues.length >= 1000) {
    log("github", `WARNING: ${project.githubRepo} returned 1000 open issues — the listing may be truncated and older fleet tickets invisible`);
  }
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
    author: issue.author?.login ?? "",
    assignees: issue.assignees.map((a) => a.login),
  }));
}

const hasFleetLabel = (issue: FleetIssue): boolean => issue.labels.some((l) => l.startsWith("fleet:"));

export async function listFleetIssues(project: ProjectConfig): Promise<FleetIssue[]> {
  const issues = await listOpenIssues(project);
  return issues
    .filter(hasFleetLabel)
    .sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels) || a.number - b.number);
}

/** Open issues carrying no `fleet:*` label — triage candidates, invisible to the board. */
export async function listNonFleetIssues(project: ProjectConfig): Promise<FleetIssue[]> {
  const issues = await listOpenIssues(project);
  return issues.filter((issue) => !hasFleetLabel(issue)).sort((a, b) => b.number - a.number);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS — every existing `listFleetIssues` caller must be unaffected. If any test fails here, the refactor changed behavior; fix it rather than updating the test.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/github/github.ts packages/daemon/src/github/github.test.ts
git commit -m "refactor(github): split listFleetIssues, add listNonFleetIssues"
```

---

## Task 7: `renderTriageSpec`

**Files:**
- Create: `packages/daemon/src/loop/triage.ts`
- Test: `packages/daemon/src/loop/triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/loop/triage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lintIntakeBody } from "@fleet/shared";
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
    expect(lintIntakeBody(renderTriageSpec(RESULT))).toEqual([]);
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
});
```

`lintIntakeBody` is the function `intake.ts` exports for a non-plan body; confirm its exact exported name with `grep -n "export function" packages/shared/src/intake.ts` and use whatever it is. The test asserts an empty array of missing sections.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/loop/triage.test.ts`
Expected: FAIL — `./triage.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/daemon/src/loop/triage.ts`:

```ts
import type { TriageResult } from "@fleet/shared";

/**
 * Renders a triage result as issue-body markdown. The three `##` headings are
 * load-bearing: intake lint refuses to claim a body missing any of them, so a
 * promoted issue that lacks one would bounce straight to `fleet:needs-input`.
 */
export function renderTriageSpec(result: TriageResult): string {
  const parts = [
    "## Problem",
    "",
    result.spec.problem,
    "",
    "## Acceptance criteria",
    "",
    result.spec.acceptanceCriteria,
    "",
    "## Verification",
    "",
    result.spec.verification,
    "",
    "---",
    "",
    `_Triaged by fleet — root cause: ${result.rootCause} (confidence ${result.confidence}%)_`,
  ];
  if (result.evidence.length > 0) {
    parts.push("", "Evidence:", ...result.evidence.map((e) => `- \`${e}\``));
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/loop/triage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/triage.ts packages/daemon/src/loop/triage.test.ts
git commit -m "feat(loop): add renderTriageSpec"
```

---

## Task 8: The triage session kind

**Files:**
- Modify: `packages/daemon/src/session/worker.ts` (lines 18, 30-36, 72-88, 182-200, 391-424, 468-484)
- Test: `packages/daemon/src/session/worker.triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/session/worker.triage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TRIAGE_OUTPUT_SCHEMA,
  buildSystemPromptAppend,
  denyForbiddenPlanBash,
} from "./worker.ts";

describe("triage session kind", () => {
  it("exposes a draft-7 output schema with no top-level conditionals", () => {
    expect(TRIAGE_OUTPUT_SCHEMA).toBeTruthy();
    expect(TRIAGE_OUTPUT_SCHEMA.oneOf).toBeUndefined();
    expect(TRIAGE_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(TRIAGE_OUTPUT_SCHEMA.anyOf).toBeUndefined();
  });

  it("uses a triage-specific system prompt", () => {
    const append = buildSystemPromptAppend("triage");
    expect(append).toContain("triage");
    expect(append).toContain("systematic-debugging");
    expect(append).not.toContain("Commit incrementally");
  });

  it("reuses the read-only bash guard, so commits are denied", () => {
    expect(denyForbiddenPlanBash("git commit -m wip")).toBeTruthy();
    expect(denyForbiddenPlanBash("git push")).toBeTruthy();
    expect(denyForbiddenPlanBash("npm test")).toBeUndefined();
  });
});
```

Confirm `denyForbiddenPlanBash`'s exact return shape first with `grep -n "denyForbiddenPlanBash" -A10 packages/daemon/src/session/worker.ts` and match the assertions to it (it may return a reason string, or an object). Adjust the third test to that shape rather than the reverse.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/session/worker.triage.test.ts`
Expected: FAIL — `TRIAGE_OUTPUT_SCHEMA` is not exported and `buildSystemPromptAppend` rejects `"triage"`.

- [ ] **Step 3: Widen `SessionKind` and add the schema**

`worker.ts:18`:

```ts
export type SessionKind = "code" | "plan" | "triage";
```

Add `TriageResultSchema` to the `@fleet/shared` import at the top, then after `PLAN_OUTPUT_SCHEMA` (line ~36):

```ts
export const TRIAGE_OUTPUT_SCHEMA = z.toJSONSchema(TriageResultSchema, {
  target: "draft-7",
}) as Record<string, unknown>;
```

- [ ] **Step 4: Add the triage contract prose**

After `PLANNER_CONTRACT`, add:

```ts
const TRIAGE_CONTRACT = `
You are a fleet triage agent: you investigate exactly one GitHub issue in a dedicated git worktree and produce a diagnosis, not a fix.

Contract:
- This is a read-only investigation. Never edit files, never commit, never push, never open PRs, and never change issue state — the orchestrator handles all of that.
- Reproduce and trace the reported problem to a specific root cause in the code. Cite concrete file:line evidence for your diagnosis.
- Use the systematic-debugging skill for this. It is available in this repo's .claude/skills/ — invoke it rather than guessing at a cause.
- Running the test suite and other read-only commands to reproduce the problem is expected and encouraged.
- Finish by producing a spec a separate coding agent could implement with no other context: a self-contained problem statement, checkable acceptance criteria, and concrete verification steps.
- Report a calibrated confidence percentage. Your score decides whether the spec goes straight to a coding agent with no human review, so an overstated number causes real harm. If you could not trace the defect to specific lines, say so with a low score rather than dressing up a guess.
- If you genuinely cannot proceed without a human decision, finish with status "blocked" and ask one specific question.
`.trim();
```

- [ ] **Step 5: Route the prompt, schema, hook, and parser**

In `buildSystemPromptAppend` (line ~72), before the plan branch:

```ts
  if (kind === "triage") return TRIAGE_CONTRACT;
```

In the constructor's `hooks.PreToolUse` (line ~411), the read-only guard now covers two kinds:

```ts
            hooks: [makeJournaledBashGuard(this.kind === "code" ? denyForbiddenBash : denyForbiddenPlanBash, opts.journal)],
```

In `outputFormat` (line ~421):

```ts
        outputFormat: {
          type: "json_schema",
          schema: this.kind === "plan" ? PLAN_OUTPUT_SCHEMA
            : this.kind === "triage" ? TRIAGE_OUTPUT_SCHEMA
            : WORKER_OUTPUT_SCHEMA,
        },
```

Add the turn result interface next to `PlanTurnResult` (line ~192):

```ts
export interface TriageTurnResult {
  kind: "triage";
  result?: TriageResult;
  errorSubtype?: string;
  terminalReason?: string;
  limitResetAt?: string;
}
```

and widen the union at line 200:

```ts
export type TurnResult = CodeTurnResult | PlanTurnResult | TriageTurnResult;
```

In `nextResult`'s success branch (line ~474), before the plan branch:

```ts
            if (this.kind === "triage") {
              const parsed = TriageResultSchema.safeParse(structuredOutput);
              if (parsed.success) return { kind: "triage", result: parsed.data };
              return { kind: "triage", errorSubtype: "invalid_structured_output", terminalReason: message.terminal_reason };
            }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/daemon/src/session/worker.triage.test.ts && pnpm typecheck`
Expected: PASS. `pnpm typecheck` is doing real work here — widening `TurnResult` will surface every unhandled `kind` at its call sites, which is exactly what Task 10 exists to fix. Expect typecheck errors in `supervise.ts` at this point; that is the correct intermediate state. Note them and move on.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/session/worker.ts packages/daemon/src/session/worker.triage.test.ts
git commit -m "feat(session): add the triage session kind"
```

---

## Task 9: `finishTriaged`

**Files:**
- Modify: `packages/daemon/src/loop/finish.ts`
- Test: `packages/daemon/src/loop/loop.triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/loop/loop.triage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const RESULT = {
  status: "completed" as const,
  summary: "s",
  rootCause: "rc",
  evidence: ["src/a.js:1"],
  confidence: 85,
  spec: { problem: "p", acceptanceCriteria: "- a", verification: "npm test" },
};

beforeEach(() => vi.clearAllMocks());

function ctxFor(threshold: number) {
  const ctx = makeCtx();
  ctx.state.upsert(makeRecord({ project: "p", issueNumber: 7, isTriage: true, bodyHashAtClaim: "h" }));
  return { ctx, project: makeProject({ name: "p", triage: true, triageAutoPromoteThreshold: threshold }) };
}

describe("finishTriaged", () => {
  it("promotes to fleet:ready when confidence meets the threshold", async () => {
    const { ctx, project } = ctxFor(80);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:ready");
  });

  it("promotes at exactly the threshold — the comparison is >=", async () => {
    const { ctx, project } = ctxFor(85);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:ready");
  });

  it("holds below the threshold", async () => {
    const { ctx, project } = ctxFor(90);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), RESULT);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("never promotes when the body was edited mid-run, even at 100", async () => {
    vi.mocked(github.appendTriageSpecSafely).mockResolvedValue("commented");
    const { ctx, project } = ctxFor(0);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), { ...RESULT, confidence: 100 });
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("never promotes a blocked result", async () => {
    const { ctx, project } = ctxFor(0);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), {
      ...RESULT, status: "blocked", blockedReason: "which browser?",
    });
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("persists the reported confidence for later threshold tuning", async () => {
    const { ctx, project } = ctxFor(80);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), RESULT);
    expect(ctx.state.get("p", 7)?.triageConfidence).toBe(85);
  });

  it("applies the suggested tier label when promoting", async () => {
    const { ctx, project } = ctxFor(80);
    await finishTriaged(ctx, project, makeIssue({ number: 7 }), { ...RESULT, suggestedTier: "light" });
    expect(github.addLabel).toHaveBeenCalledWith(project, 7, "fleet:light");
  });
});
```

If `github.ts` has no `addLabel` export, add one in the same style as `swapLabel`:

```ts
export async function addLabel(project: ProjectConfig, issueNumber: number, label: string): Promise<void> {
  await run("gh", ["issue", "edit", String(issueNumber), "--repo", project.githubRepo, "--add-label", label]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/loop/loop.triage.test.ts`
Expected: FAIL — `finishTriaged` is not exported from `./finish.ts`.

- [ ] **Step 3: Write the implementation**

Add to `packages/daemon/src/loop/finish.ts`, following the shape of `finishPlanned` (line 198) for status-comment and state handling:

```ts
/**
 * Terminal path for a triage session. Writes the spec into the issue body when
 * no human edited it mid-run, then promotes to `fleet:ready` only when the run
 * completed cleanly and its confidence meets the project threshold.
 *
 * Triage fails closed, the inverse of machine review's fail-open: a collision,
 * a blocked result, or any error holds the ticket for a human. A failed review
 * costs a missed check; a triage that promoted on a failure would start an
 * unsupervised coding session on an undiagnosed bug.
 */
export async function finishTriaged(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: { number: number; title: string },
  result: TriageResult,
): Promise<void> {
  const record = ctx.state.get(project.name, issue.number);
  ctx.state.update(project.name, issue.number, { triageConfidence: result.confidence });

  const spec = renderTriageSpec(result);
  const written = await appendTriageSpecSafely(project, issue.number, spec, record?.bodyHashAtClaim ?? "");

  const promote =
    result.status === "completed" &&
    written === "appended" &&
    result.confidence >= project.triageAutoPromoteThreshold;

  const held =
    written === "commented" ? "the issue body was edited while triage was running"
      : result.status === "blocked" ? `triage is blocked: ${result.blockedReason ?? "no reason given"}`
      : `confidence ${result.confidence}% is below the ${project.triageAutoPromoteThreshold}% auto-promote threshold`;

  await upsertStatusComment(project, issue.number, [
    `**Triage complete** — confidence ${result.confidence}%`,
    "",
    `**Root cause:** ${result.rootCause}`,
    ...(result.evidence.length > 0 ? ["", "**Evidence:**", ...result.evidence.map((e) => `- \`${e}\``)] : []),
    "",
    result.summary,
    "",
    promote
      ? "Promoted to `fleet:ready` — a coding worker will claim it on a later cycle."
      : `Held for review — ${held}.`,
  ].join("\n"));

  if (promote) {
    if (result.suggestedTier === "light") await addLabel(project, issue.number, LIGHT_LABEL);
    if (result.suggestedTier === "elevated") await addLabel(project, issue.number, ELEVATE_LABEL);
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.ready);
  } else {
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
  }
}
```

Add the imports this needs at the top of `finish.ts`: `renderTriageSpec` from `./triage.ts`, `appendTriageSpecSafely` and `addLabel` from `../github/github.ts`, and `TriageResult`, `LIGHT_LABEL`, `ELEVATE_LABEL` from `@fleet/shared`.

Note the tier labels go on **before** the label swap, so the issue is never briefly `fleet:ready` without its tier — the claim loop could otherwise pick it up mid-write on the wrong model.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/loop/loop.triage.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/loop/finish.ts packages/daemon/src/loop/loop.triage.test.ts packages/daemon/src/github/github.ts
git commit -m "feat(loop): add finishTriaged terminal path"
```

---

## Task 10: Claim and supervise triage tickets

**Files:**
- Modify: `packages/daemon/src/loop/claim.ts:428-467`
- Modify: `packages/daemon/src/loop/runner.ts:235-264`
- Modify: `packages/daemon/src/loop/supervise.ts:58-74`
- Test: `packages/daemon/src/loop/loop.triage.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/src/loop/loop.triage.test.ts`:

```ts
describe("triage claiming", () => {
  it("captures the body hash at claim time", async () => {
    const { hashBody } = await import("../github/github.ts");
    const body = "Original reported symptom";
    // Claim a fleet:triage issue through the normal claim path, then assert:
    // ctx.state.get("p", 7)?.bodyHashAtClaim === hashBody(body)
    // Follow the harness already used in loop.claim.test.ts for driving cycleProject.
    expect(hashBody(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not claim a fleet:triage issue when project.triage is false", async () => {
    // project = makeProject({ triage: false }); issue carries fleet:triage
    // assert swapLabel was never called with fleet:in-progress
  });
});
```

Read `loop/loop.claim.test.ts` first and copy its harness for driving a cycle — do not invent a new one. Replace the two placeholder bodies above with real assertions built on that harness before moving to Step 2. **These two tests must contain real assertions; a plan step is not done while a test body is a comment.**

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/loop/loop.triage.test.ts`
Expected: FAIL — triage issues are not claimed.

- [ ] **Step 3: Claim triage issues**

In `packages/daemon/src/loop/claim.ts` near line 428, alongside the existing `isPlan`:

```ts
    const isPlan = issue.labels.includes(PLAN_LABEL);
    const isTriage = !isPlan && project.triage && issue.labels.includes(TRIAGE_LABEL);
```

`isPlan` wins if somebody applies both — a decomposition and an investigation are different jobs and silently doing the wrong one is worse than picking deterministically.

Add to the `ctx.state.upsert(...)` record near line 445:

```ts
      isTriage,
      bodyHashAtClaim: isTriage ? hashBody(issue.body) : undefined,
```

Update the session open near line 467:

```ts
      kind: isPlan ? "plan" : isTriage ? "triage" : "code",
```

Import `TRIAGE_LABEL` from `@fleet/shared` and `hashBody` from `../github/github.ts`.

The eligibility filter that currently selects `fleet:ready` issues must also admit `fleet:triage` ones when `project.triage` is true. Find that predicate in `claim.ts` and widen it; leave the `fleet:ready` path untouched.

- [ ] **Step 4: Handle the resume path**

In `packages/daemon/src/loop/runner.ts` near line 235, mirror the `isPlan` handling:

```ts
    let isTriage = record.isTriage ?? false;
```

refresh it from live labels in the same block that refreshes `isPlan` (line ~246), persist it in the same `ctx.state.update` (line ~251), and widen the kind at line ~264:

```ts
      kind: isPlan ? "plan" : isTriage ? "triage" : "code",
```

Do **not** recompute `bodyHashAtClaim` on resume. The hash must reflect the body the *investigation* started from; refreshing it on resume would silently forgive an edit made while the session was down, which is the exact case the collision check exists to catch.

- [ ] **Step 5: Dispatch in supervise**

In `packages/daemon/src/loop/supervise.ts`, after the `turn.kind === "plan"` block (which ends at line 74), add:

```ts
    if (turn.kind === "triage") {
      if (turn.result?.status === "completed" || turn.result?.status === "blocked") {
        await finishTriaged(ctx, project, issue, turn.result);
        return;
      }
      await finishFailed(ctx, project, issue, formatTurnError(turn));
      return;
    }
```

A blocked triage goes to `finishTriaged` rather than `park`: the spec it produced is still worth preserving, and `finishTriaged` already routes blocked to `fleet:needs-input`. Import `finishTriaged` from `./finish.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. The `TurnResult` union widening from Task 8 should now be exhaustively handled.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/loop/claim.ts packages/daemon/src/loop/runner.ts packages/daemon/src/loop/supervise.ts packages/daemon/src/loop/loop.triage.test.ts
git commit -m "feat(loop): claim and supervise triage tickets"
```

---

## Task 11: REST routes

**Files:**
- Modify: `packages/daemon/src/server/server.ts`
- Test: `packages/daemon/src/server/server.triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/server/server.triage.test.ts`:

```ts
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  listNonFleetIssues: vi.fn(async () => [
    { number: 4, title: "plain bug", body: "b", labels: ["bug"], url: "u4", author: "isaacalger", assignees: [] },
  ]),
  getIssue: vi.fn(async () => ({ number: 4, title: "plain bug", body: "b", labels: ["bug"] })),
  addLabel: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const enabled = makeProject({ name: "alpha", triage: true });
const disabled = makeProject({ name: "beta", triage: false });

function makeApp(projects = [enabled, disabled]) {
  const { dataDir, state } = makeTempState("fleet-server-triage-");
  const config = makeFleetConfig({ dataDir, projects });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/triage", () => {
  it("lists non-fleet issues for triage-enabled projects only", async () => {
    const res = await makeApp().request("/api/triage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.map((p: { project: string }) => p.project)).toEqual(["alpha"]);
    expect(body.projects[0].issues[0].number).toBe(4);
  });

  it("reports a listing failure per project instead of failing the whole request", async () => {
    vi.mocked(github.listNonFleetIssues).mockRejectedValue(new Error("gh exploded"));
    const res = await makeApp().request("/api/triage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects[0].issues).toEqual([]);
    expect(body.projects[0].error).toBeTruthy();
  });
});

describe("POST /api/triage/:project/:issue/investigate", () => {
  it("adds the fleet:triage label", async () => {
    const res = await postJson(makeApp(), "/api/triage/alpha/4/investigate", {});
    expect(res.status).toBe(200);
    expect(github.addLabel).toHaveBeenCalledWith(enabled, 4, "fleet:triage");
  });

  it("409s on an issue already carrying a fleet:* label", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({ number: 4, title: "t", body: "b", labels: ["fleet:ready"] });
    const res = await postJson(makeApp(), "/api/triage/alpha/4/investigate", {});
    expect(res.status).toBe(409);
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("400s when triage is disabled for the project", async () => {
    const res = await postJson(makeApp(), "/api/triage/beta/4/investigate", {});
    expect(res.status).toBe(400);
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("404s on an unknown project", async () => {
    const res = await postJson(makeApp(), "/api/triage/nope/4/investigate", {});
    expect(res.status).toBe(404);
  });
});
```

If `postJson` does not expose `.request()` on the app for the GET cases, use whatever the other server tests use for GETs (check `server.digest.test.ts`) rather than adding a helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/server/server.triage.test.ts`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the routes**

In `packages/daemon/src/server/server.ts`, next to the other project routes (near line 337):

```ts
  app.get("/api/triage", async (c) => {
    const projects = config.projects.filter((p) => p.triage);
    const results = await Promise.all(projects.map(async (project) => {
      try {
        const issues = await listNonFleetIssues(project);
        return { project: project.name, issues };
      } catch (err) {
        logError("server", `triage listing failed for ${project.name}`, err);
        return { project: project.name, issues: [], error: "listing failed" };
      }
    }));
    return c.json({ projects: results });
  });

  app.post("/api/triage/:project/:issue/investigate", async (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    const project = config.projects.find((p) => p.name === projectName);
    if (!project) return c.json({ error: "unknown project" }, 404);
    if (!project.triage) return c.json({ error: "triage is disabled for this project" }, 400);

    const issue = await getIssue(project, issueNumber);
    if (!issue) return c.json({ error: "issue not found" }, 404);
    if (issue.labels.some((l) => l.startsWith("fleet:"))) {
      return c.json({ error: "issue already carries a fleet:* label" }, 409);
    }

    await addLabel(project, issueNumber, TRIAGE_LABEL);
    return c.json({ ok: true, queued: true });
  });
```

The 409 matters: an issue already in the fleet pipeline must not be re-entered through triage, and a double-click on Investigate must not queue two sessions.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/server/server.triage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/server/server.ts packages/daemon/src/server/server.triage.test.ts
git commit -m "feat(server): add triage listing and investigate routes"
```

---

## Task 12: Triage panel

**Files:**
- Create: `packages/dashboard/src/components/TriagePanel.vue`
- Create: `packages/dashboard/src/components/TriagePanel.test.ts`
- Modify: `packages/dashboard/src/App.vue`

- [ ] **Step 1: Write the failing test**

Read `packages/dashboard/src/components/FileTicketPanel.test.ts` first and copy its mount/stub conventions. Then create `TriagePanel.test.ts` asserting:

- renders one row per issue returned by `/api/triage`, showing number, title, and existing labels
- clicking **Investigate** POSTs to `/api/triage/:project/:issue/investigate`
- the button is disabled and reads "Queued" after a successful POST
- a project whose response carries `error` renders an inline error rather than an empty list

Write real assertions against the real component API before Step 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/dashboard/src/components/TriagePanel.test.ts`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the component**

Create `TriagePanel.vue` following the structure of `FileTicketPanel.vue` (script setup, `<template>`, Tailwind 4 utility classes, the shared fetch helper in `src/lib/`). It must:

- fetch `/api/triage` on mount and on the existing `board-updated` WS ping
- group by project, with a per-project heading
- per issue: number, title, labels, author, and a body excerpt (first ~200 chars)
- an **Investigate** button per issue that POSTs, then shows "Queued — a session will start on the next cycle"
- render nothing at all when every project has an empty list, so the panel is invisible on a clean backlog

Copy the empty-state and error-state idiom from `FileTicketPanel.vue` rather than inventing one.

- [ ] **Step 4: Mount it**

In `packages/dashboard/src/App.vue`, add `<TriagePanel />` beside the existing panels, and import it. Place it below the board, above `HistoryView`.

- [ ] **Step 5: Run tests and build**

Run: `pnpm vitest run packages/dashboard/src/components/TriagePanel.test.ts && pnpm dashboard:build`
Expected: PASS, and a clean `vue-tsc` build.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/components/TriagePanel.vue packages/dashboard/src/components/TriagePanel.test.ts packages/dashboard/src/App.vue
git commit -m "feat(dashboard): add the Triage panel"
```

---

## Task 13: Vendor the systematic-debugging skill

**Files:**
- Create: `templates/systematic-debugging/SKILL.md`
- Modify: `packages/daemon/src/sync-templates.ts:9-10, 200-206`
- Test: `packages/daemon/src/sync-templates.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/src/sync-templates.test.ts` (follow its existing temp-repo harness):

```ts
it("stamps the systematic-debugging skill into the target repo", () => {
  const repo = makeTempRepo();
  syncTemplates(makeFleetConfig({ projects: [makeProject({ repoPath: repo })] }));
  const dest = join(repo, ".claude", "skills", "systematic-debugging", "SKILL.md");
  expect(existsSync(dest)).toBe(true);
  expect(readFileSync(dest, "utf8")).toContain("name: systematic-debugging");
});

it("keeps the fleet-backlog skill alongside it", () => {
  const repo = makeTempRepo();
  syncTemplates(makeFleetConfig({ projects: [makeProject({ repoPath: repo })] }));
  expect(existsSync(join(repo, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/src/sync-templates.test.ts`
Expected: FAIL — the destination file does not exist.

- [ ] **Step 3: Vendor the skill file**

Copy the upstream skill:

```bash
mkdir -p templates/systematic-debugging
cp ~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/skills/systematic-debugging/SKILL.md \
   templates/systematic-debugging/SKILL.md
```

Then add a provenance block immediately below the closing `---` of its frontmatter, so the copy's origin is never guessed at:

```markdown
<!--
Vendored from superpowers v5.1.0 (skills/systematic-debugging).
Stamped into target repos by `pnpm daemon sync-templates` because fleet worker
sessions run with settingSources: ["project"] and cannot see user-level plugins.
Re-copy from upstream and re-run sync-templates to update.
-->
```

Confirm the frontmatter still parses as the first thing in the file — the comment goes *after* the frontmatter block, never before it.

- [ ] **Step 4: Stamp it**

In `packages/daemon/src/sync-templates.ts`, beside `SKILL_TEMPLATE_PATH` (line 9):

```ts
const DEBUGGING_SKILL_TEMPLATE_PATH = join(TEMPLATES_DIR, "systematic-debugging", "SKILL.md");
```

Then, in the same function that writes the fleet-backlog skill (line ~202), add a second write in exactly the same style:

```ts
  const debuggingDest = join(project.repoPath, ".claude", "skills", "systematic-debugging", "SKILL.md");
  mkdirSync(dirname(debuggingDest), { recursive: true });
  writeFileSync(debuggingDest, readFileSync(DEBUGGING_SKILL_TEMPLATE_PATH, "utf8"));
  log("sync-templates", `wrote ${debuggingDest}`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/src/sync-templates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add templates/systematic-debugging/SKILL.md packages/daemon/src/sync-templates.ts packages/daemon/src/sync-templates.test.ts
git commit -m "feat(templates): vendor the systematic-debugging skill"
```

---

## Task 14: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

Add a `## Triage` section to `README.md`, after `## Epic decomposition (fleet:plan)`:

```markdown
## Triage (`fleet:triage`)

Issues carrying no `fleet:*` label are invisible to the board by design. With
`triage: true` on a project, the dashboard's **Triage** panel lists them and
offers an **Investigate** button per issue.

Investigate adds a `fleet:triage` label; the next poll cycle claims it as a
read-only investigation that runs the vendored `systematic-debugging` skill,
traces the reported symptom to a root cause, and produces a spec with
`## Problem` / `## Acceptance criteria` / `## Verification` sections plus a
whole-number confidence percentage.

On completion the spec is appended to the issue body and, if confidence is at or
above `triageAutoPromoteThreshold` (default 80), the issue is labeled
`fleet:ready` for an ordinary coding worker. Below the threshold — or on a
blocked result, an error, or a human editing the issue body mid-run — it lands
in `fleet:needs-input` instead. Triage never promotes on failure.
```

- [ ] **Step 2: Full verification**

**REQUIRED SUB-SKILL:** invoke the `verify` skill for this repo's full check sequence.

```bash
nvm use 24
pnpm typecheck
pnpm test
pnpm daemon -- --dry-run --once
```

Expected: typecheck clean, all tests pass, and the dry run logs a cycle for each configured project with no errors.

- [ ] **Step 3: Manual end-to-end against a real repo**

```bash
nvm use 24
pnpm daemon init-labels      # creates fleet:triage in each configured repo
pnpm daemon sync-templates   # stamps the vendored skill; commit the result in the target repo
pnpm daemon
```

Then, with `triage: true` set on the project:

1. Open http://localhost:4400 and confirm the Triage panel lists `isaacalger/Snake#4` (labeled only `bug`).
2. Click **Investigate**; confirm `fleet:triage` appears on the issue within a second.
3. Within ~60s confirm the daemon claims it and the ticket shows `in-progress`.
4. When it finishes, confirm on the issue: a status comment with root cause, evidence, and confidence; the spec appended to the body under the three headings; and either `fleet:ready` or `fleet:needs-input` consistent with the reported confidence versus the threshold.
5. Confirm the promoted body passes intake lint by watching the next cycle claim it as an ordinary coding ticket rather than bouncing it to `fleet:needs-input`.

- [ ] **Step 4: Test the collision path by hand**

This path cannot be exercised by the happy path and is the highest-risk logic in the feature:

1. Investigate another issue.
2. While the session is running, edit that issue's body on GitHub — change a single character.
3. Confirm on completion that the body was **not** appended to, that a separate comment carries "Concurrent edit detected" with the full spec, and that the issue is `fleet:needs-input` regardless of the reported confidence.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the triage stage"
```

---

## Self-review notes

Checked against the spec, section by section:

- Triage panel → Tasks 6, 11, 12
- Triage runs as a ticket / `fleet:triage` label → Tasks 2, 10
- Contract → Task 1
- Terminal path → Task 9
- Concurrent human edits → Tasks 5, 9 (Step 3 of Task 10 covers the no-refresh-on-resume rule)
- Config → Task 3
- Vendoring → Task 13
- Data flow, error handling table → Tasks 9, 10, 11
- Testing list → distributed across Tasks 1, 2, 5, 7, 9, 10; the "label swaps do not trip collision detection" regression is covered structurally, since detection never reads `updatedAt`

**Known gaps a reviewer should watch for:**

- Tasks 10 and 12 contain test skeletons whose bodies must be written against harnesses that already exist in the repo (`loop.claim.test.ts` for driving a cycle, `FileTicketPanel.test.ts` for component mounting). Those are deliberate pointers to existing conventions rather than invented ones — but **a task is not complete while a test body is still a comment.** Task 11's tests are written out in full and can be used as the model for the shape the other two should end up in.
- ~~`store/db.ts` column work in Task 4~~ — **corrected during execution.** The original plan asserted per-field SQLite columns and an `ALTER TABLE` migration list mirroring `isPlan`. No such thing exists: tickets are stored as a JSON blob in a `data` column. Task 4 above now reflects reality. No other task depended on the wrong premise.
- The `addLabel` helper may or may not already exist in `github.ts`; Task 9 Step 1 says to add it if absent. Check before writing a duplicate.
