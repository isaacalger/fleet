# Pipeline-wide confidence

Every scored fleet session reports a calibrated 0–100 confidence. The score is
persisted as an append-only trail on the ticket, shown at the top of the
dashboard detail panel and on every board card including the Done column, and
gates progress: a session scoring below the
project's threshold stops the ticket in the needs-attention bucket instead of
pushing, opening a PR, or filing child tickets.

## Motivation

Confidence already exists in three places and helps in none of them:

- `WorkerResultSchema.confidence` and `PlanResultSchema.confidence`
  (`packages/shared/src/contracts.ts:10`, `:48`) are `low|medium|high`. They are
  interpolated verbatim into the GitHub status comment
  (`packages/daemon/src/loop/finish.ts:162`, `:231`, `:283`) and never persisted.
- `TriageResultSchema.confidence` (`contracts.ts:69`) is an int 0–100. It is
  persisted as `TicketRecord.triageConfidence`
  (`packages/shared/src/tickets.ts:39`) and read by exactly one caller, the
  auto-promote comparison at `finish.ts:343`. Nothing displays it.
- The two review schemas have no confidence at all.

So the operator cannot see, at any step, how sure the agent was — and nothing
but triage acts on it.

## Design

### 1. Contracts: one scale, five stages

In `packages/shared/src/contracts.ts`:

- `WorkerResultSchema.confidence`: `z.enum(["low","medium","high"])` →
  `z.number().int().min(0).max(100)`
- `PlanResultSchema.confidence`: same change
- `MachineReviewResultSchema`: gains `confidence: z.number().int().min(0).max(100)`
- `PlanReviewResultSchema`: gains the same field
- `TriageResultSchema`: unchanged

`TriageResultSchema` converts to JSON Schema without top-level combinators, and
these are plain integer fields, so the `outputFormat` conversion in
`session/worker.ts` stays safe.

The system prompts for the code, plan, machine-review, and plan-review sessions
in `packages/daemon/src/session/worker.ts` gain the calibrated-percentage
instruction that the triage prompt already carries at `worker.ts:78`.

`finishCompleted` and its plan counterparts currently declare a `confidence:
string` parameter (`finish.ts:128`, `loop/loop.ts:283`). Both become `number`,
and the status-comment interpolation formats as `N%`.

### 2. Persistence: an append-only trail

`packages/shared/src/tickets.ts` gains:

```ts
export type ConfidenceStage =
  | "triage"
  | "plan"
  | "code"
  | "machine-review"
  | "plan-review";

export interface ConfidenceEntry {
  stage: ConfidenceStage;
  score: number;      // 0-100
  threshold: number;  // the project's threshold when this score was recorded
  at: string;         // ISO timestamp
}
```

`threshold` is stamped onto the entry at write time rather than looked up at
render time. A Done-column card shows a ticket that closed long ago, whose
project may since have changed its `confidenceThreshold` or been removed from
config entirely (`issueUrl` in `loop/board.ts:11-18` already handles that case
for URLs). Stamping makes every entry self-describing, so the same rendering
code colors live and archived tickets correctly with no config lookup on the
client at all.

and `TicketRecord` gains `confidenceHistory?: ConfidenceEntry[]` (absent on
records predating this field).

No SQL migration is required. The `tickets` table stores the whole record as a
JSON blob in a `data` column (`packages/daemon/src/store/db.ts:64-120`), so a new
optional field is purely a TypeScript change, written via
`ctx.state.update(project, issue, { confidenceHistory })`.

`triageConfidence` is retained unchanged. Triage writes both it and a
`confidenceHistory` entry. The small duplication is deliberate: the existing
auto-promote comparison and its tests keep reading the field they already read,
so this change cannot regress triage behavior. A triage entry stamps
`triageAutoPromoteThreshold` as its `threshold`, since that is the bar that
score was actually judged against.

Entries are appended, never replaced. A machine-review fix round or an operator
restart therefore leaves a visible trajectory rather than overwriting history —
a score that drops between stages is precisely the signal worth seeing.

### 3. Config

`ProjectConfigSchema` in `packages/shared/src/config.ts` gains:

```ts
confidenceThreshold: z.number().int().min(0).max(100).default(70)
```

It governs the plan, code, machine-review, and plan-review stages. Triage keeps
its own `triageAutoPromoteThreshold`, whose auto-promote-or-hold semantics are
distinct and already documented; no triage behavior changes.

Per the `config-shape-change` skill, four files change together:

1. `packages/shared/src/config.ts` — the schema above
2. `fleet.config.example.json` — the field with its default
3. `README.md` — the per-project config table
4. `packages/daemon/src/test-support.ts` — the project fixture factory

### 4. Gating

A new `packages/daemon/src/loop/confidence.ts` exports two plain functions in
the established `loop/` shape (`LoopContext` first, no callbacks into
`FleetLoop`):

- `recordConfidence(ctx, project, issue, stage, score)` — appends a
  `ConfidenceEntry` and persists the record.
- `belowThreshold(project, score)` — `score < project.confidenceThreshold`.

Call sites, all in `loop/supervise.ts` and `loop/finish.ts`:

| Stage | Where | Below threshold |
| --- | --- | --- |
| `code` | worker returns `completed`, after the machine-review gate, before the push/PR step | hold; nothing is pushed and no PR is opened |
| `plan` | plan returns `completed`, after `planReviewGate`, before `finishPlanned` | hold; no child issues are filed and the epic stays out of `fleet:review` |
| `machine-review` | reviewer result, alongside the existing verdict handling | hold |
| `plan-review` | reviewer result, same | hold |
| `triage` | unchanged | governed by `triageAutoPromoteThreshold` |

**Holding** reuses the existing blocked path rather than introducing a new
terminal state. The ticket is labeled `fleet:needs-input`, the status comment is
updated to name the stage, its score, the threshold, and the result's own
`summary`, and the session is held open for `replyWaitMinutes` and remains
resumable afterward via `resume: sessionId`. Replying from the dashboard steers
the still-live session exactly as it does for a worker-reported `blocked`, so
this adds no new operator workflow.

Recording happens before the threshold comparison, so a held ticket's score is
visible in the dashboard as soon as it is held.

#### Reviewer confidence inverts one existing contract, deliberately

The machine reviewer currently fails **open**: any reviewer failure sends the
ticket on to human review rather than blocking it (`session/review.ts`). Gating
on reviewer confidence inverts that for one specific case — a review that
completed but reports low confidence in its own judgment.

This is intended. A review the reviewer does not trust is exactly the case that
warrants a human, and `fleet:needs-input` is where a human looks. Fail-open
remains in force for every other reviewer failure mode: crashes, timeouts, and
unparseable output still pass the ticket through to human review as they do
today.

### 5. Dashboard

No new plumbing is needed for either surface. `getBoard` attaches the whole
`TicketRecord` to active tickets (`loop/board.ts:50-56`) and
`synthesizeDoneTickets` attaches the `ClosedTicketRecord` — which extends
`TicketRecord` — to Done ones (`loop/board.ts:44`). So `confidenceHistory`
reaches every card and the detail panel already, and each entry carries its own
threshold. `BoardTicket` is unchanged.

A shared `ConfidenceBadge.vue` renders one entry in two sizes, so the color
rule and the score formatting live in one place:

- **at or above** its stamped `threshold` — green
- **below** — red

`packages/dashboard/src/components/TicketDetail.vue`: the badge in the header
block, immediately above the meta row at `:306`, showing the most recent entry
labeled with its stage (`Code 91%`). Clicking it expands the full trail in
order: `Triage 88% → Code 91% → Review 74%`.

`packages/dashboard/src/components/TicketCard.vue`: the compact badge alongside
the existing plan/triage badges at `:91-92`, showing the latest entry's score
only (`91%`) — the card is dense and the stage is largely implied by the column.
This applies to every column, Done included: a closed ticket's badge is the last
score it ever recorded, which is the "how sure was the agent about the thing
that shipped?" number.

A ticket with no `confidenceHistory` renders no badge on either surface — this
is the normal state for every ticket predating the field, so both surfaces must
degrade silently rather than showing a zero or a placeholder.

### 6. Testing

- `packages/shared/src/index.test.ts` — the four changed/extended schemas:
  integer 0–100 accepted, out-of-range and non-integer rejected, review schemas
  require the new field.
- `packages/daemon/src/loop/confidence.test.ts` (new) — `recordConfidence`
  appends rather than replaces and preserves order; `belowThreshold` boundary
  (a score exactly equal to the threshold passes).
- Additions to the existing finish/supervise tests, one pair per gated stage:
  above threshold proceeds normally; below threshold holds, applies
  `fleet:needs-input`, and asserts nothing was pushed, no PR opened, and for the
  plan path no child issues filed.
- A `ConfidenceBadge` render test: color flips across the stamped threshold,
  including the boundary (equal to threshold renders green).
- A `TicketDetail` render test: badge shows the latest entry with its stage,
  expansion lists the whole trail, absent history renders nothing.
- A `TicketCard` render test: compact badge shows the latest score, absent
  history renders nothing, and a synthesized Done-column ticket built from a
  `ClosedTicketRecord` renders its badge.

Fixtures come from `packages/daemon/src/test-support.ts` per the `write-tests`
skill.

Verification is `pnpm typecheck` and `pnpm test`, plus a `--dry-run --once`
daemon run per the `verify` skill.

## Out of scope

- A confidence column in the history table (`HistoryRecord`) or any cross-ticket
  confidence rollup in `HistoryAggregates`. The Done-column *cards* are in
  scope; the separate history view's table and aggregates are not.
- Any retry or self-correction round driven by a low score. Below-threshold
  holds and waits for a human; the machine-review gate's existing one-shot fix
  round is unchanged.
- Reworking or renaming `triageAutoPromoteThreshold`.
- Backfilling `confidenceHistory` for existing tickets.
