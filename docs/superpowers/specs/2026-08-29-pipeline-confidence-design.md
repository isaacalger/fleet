# Pipeline-wide confidence

Every scored fleet session reports a calibrated 0–100 confidence. The score is
persisted as an append-only trail on the ticket, shown at the top of the
dashboard detail panel and on every board card including the Done column, and
gates progress: a session scoring below the project's threshold stops the ticket
in the needs-attention bucket instead of pushing, opening a PR, or filing child
tickets.

## Motivation

Confidence already exists in three places and helps in none of them:

- `WorkerResultSchema.confidence` and `PlanResultSchema.confidence`
  (`packages/shared/src/contracts.ts:10`, `:48`) are `low|medium|high`. They are
  interpolated verbatim into the GitHub status comment
  (`packages/daemon/src/loop/finish.ts:162`, `:231`, `:283`) and never persisted.
- `TriageResultSchema.confidence` (`contracts.ts:69`) is an int 0–100. It is
  persisted as `TicketRecord.triageConfidence`
  (`packages/shared/src/tickets.ts:39`) and read by exactly one caller, the
  auto-promote comparison at `finish.ts:341`. Nothing displays it.
- The two review schemas have no confidence at all.

So the operator cannot see, at any step, how sure the agent was — and nothing
but triage acts on it.

## Design

### 1. Contracts: one scale, five stages

In `packages/shared/src/contracts.ts`:

- `WorkerResultSchema.confidence`: `z.enum(["low","medium","high"])` →
  `ConfidenceScoreSchema` (below)
- `PlanResultSchema.confidence`: same change
- `MachineReviewResultSchema`: gains `confidence: ConfidenceScoreSchema`
- `PlanReviewResultSchema`: gains the same field
- `TriageResultSchema`: unchanged (already `z.number().int().min(0).max(100)`)

The system prompts for the code, plan, machine-review, and plan-review sessions
in `packages/daemon/src/session/worker.ts` gain the calibrated-percentage
instruction that the triage prompt already carries at `worker.ts:78`.

`finishCompleted` and its plan counterparts currently declare a `confidence:
string` parameter (`finish.ts:128`, `loop/loop.ts:283`). Both become `number`,
and the status-comment interpolation formats as `N%`.

#### Transitional string coercion

The coercion lives **outside** the schema, applied to a session's raw
structured output before it reaches zod:

```ts
export const ConfidenceScoreSchema = z.number().int().min(0).max(100);

/** TRANSITIONAL: maps the pre-migration `low|medium|high` strings onto the 0-100 scale. */
export function normalizeLegacyConfidence<T>(raw: T): T { /* … */ }
```

It cannot live in the schema. A `z.union` or `z.transform` makes
`z.toJSONSchema` throw `Transforms cannot be represented in JSON Schema`, and
the daemon builds its `outputFormat` from these schemas at **module load**
(`WORKER_OUTPUT_SCHEMA`/`PLAN_OUTPUT_SCHEMA` at `session/worker.ts:32-42`,
`MACHINE_REVIEW_OUTPUT_SCHEMA`/`PLAN_REVIEW_OUTPUT_SCHEMA` at
`session/review.ts:17-22`) — so a union stops the daemon booting rather than
failing a typecheck. Converting with `io: "input"` avoids the throw but
advertises `low|medium|high` to the model as valid output, contradicting the
prompt change above. Normalizing at the parse boundary keeps the advertised
schema honest while still rescuing legacy sessions.

This is not a rare edge case, it is the common path on the deploy itself.
Deploying requires a daemon restart; restart reconciles running tickets to
`stalled` (`StateStore.clearLiveFlags()`); `recoverStalled` then resumes each one
into its *existing* SDK session, whose context still contains the old
`low|medium|high` instruction. Those sessions will emit strings.

Without the shim the failure is quiet and expensive. A schema mismatch is not a
crash and not `blocked`: `safeParse` at `worker.ts:502-518` yields a turn with no
`result` and `errorSubtype: "invalid_structured_output"`, which falls past both
branches in `supervise.ts` to `finishFailed` — burning the ticket's once-only
auto-elevate on a retry that cannot succeed, then parking it in
`fleet:needs-input` with only a `terminal_reason` string as diagnostic (the
stderr tail is deliberately not journaled for this subtype, `worker.ts:534-538`).

The chosen mapping reads correctly against the default threshold of 70: `high`
(90) proceeds, `medium` (60) and `low` (30) hold.

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
  score: number;             // 0-100
  /** The threshold this score was judged against, or null when the stage was recorded but not gated. */
  threshold: number | null;
  /** Present only when a `fleet:confidence-overridden` label carried this score past its gate. */
  overridden?: true;
  at: string;                // ISO timestamp
}
```

and `TicketRecord` gains `confidenceHistory?: ConfidenceEntry[]` (absent on
records predating this field).

No SQL migration is required. The `tickets` table stores the whole record as a
JSON blob in a `data` column (`packages/daemon/src/store/db.ts:64-120`), so a new
optional field is purely a TypeScript change, written via
`ctx.state.update(project, issue, { confidenceHistory })`.

`threshold` is stamped onto the entry at write time rather than looked up at
render time. A Done-column card shows a ticket that closed long ago, whose
project may since have changed its `confidenceThreshold` or been removed from
config entirely (`issueUrl` in `loop/board.ts:11-18` already handles that case
for URLs). Stamping makes every entry self-describing, so the same rendering
code colors live and archived tickets correctly with no config lookup on the
client at all.

`triageConfidence` is retained and still written, so existing records and any
consumer of that field keep working — but it is no longer read for the promote
decision, which now comes from the shared gate (§4). It becomes a plain
historical field rather than a control input.

Entries are appended, never replaced. A machine-review fix round or an operator
restart therefore leaves a visible trajectory rather than overwriting history —
a score that drops between stages is precisely the signal worth seeing.

### 3. Config and labels

`ProjectConfigSchema` in `packages/shared/src/config.ts` gains:

```ts
confidenceThreshold: z.number().int().min(0).max(100).default(70)
```

It governs **all five stages, triage included**. `triageAutoPromoteThreshold` is
removed.

Triage does not need its own bar. Its existing rule — at or above the threshold,
auto-promote to `fleet:ready`; below it, hold in `fleet:needs-input`
(`finish.ts:336-350`, `:381-382`) — is the general gate with "proceed" meaning
"promote". Collapsing them means one number to reason about and one code path to
maintain, and it makes triage a stage in the pipeline rather than a special case
bolted to its side.

Two consequences follow.

**The "never auto-promote" sentinel becomes a boolean.** Today
`triageAutoPromoteThreshold` is `.max(101)` where 101 means "hold every triage
for human review" (`config.ts:55-62`). That trick cannot survive the merge — 101
on a shared threshold would hold every stage of every ticket. The capability is
worth keeping, so it moves to its own flag:

```ts
triageAutoPromote: z.boolean().default(true)
```

When `false`, triage records its score with `threshold: null` (recorded, not
gated) and always holds. This is a mode, not a second threshold, so it doesn't
reintroduce the thing being removed.

**The triage bar moves from 80 to 70.** The two defaults differed. Rather than
let that change behavior silently, loading a config that still contains
`triageAutoPromoteThreshold` is a **startup error** naming the replacement
(`confidenceThreshold`, or `triageAutoPromote: false` if the old value was 101).
Zod strips unknown keys by default, so without an explicit check a project
configured to never auto-promote would quietly begin promoting at 70 — the worst
possible outcome of a config rename.

**Held triage gains an override for free.** There is no "promote this triage"
label or button today; a held triage ticket is terminal until a human edits the
spec and re-labels `fleet:ready` (which claims it as a *code* ticket, not a
re-triage). Once triage runs through the shared gate,
`fleet:confidence-overridden` promotes it like any other stage.

Per the `config-shape-change` skill, four files change together:

1. `packages/shared/src/config.ts` — the schema above
2. `fleet.config.example.json` — the field with its default
3. `README.md` — the per-project config table
4. `packages/daemon/src/test-support.ts` — the project fixture factory

`packages/shared/src/labels.ts` gains `CONFIDENCE_OVERRIDE_LABEL =
"fleet:confidence-overridden"`, registered in `ALL_FLEET_LABELS` so
`init-labels` creates it (and so the on-demand label creation added in `d6ba524`
covers repos that never re-run it). It is not a status label and takes no part
in `boardStatusFromLabels`.

### 4. Gating

A new `packages/daemon/src/loop/confidence.ts` exports the gate in the
established `loop/` shape (`LoopContext` first, no callbacks into `FleetLoop`):

- `recordConfidence(ctx, project, issue, stage, score, threshold, overridden?)`
  — appends a `ConfidenceEntry` and persists the record.
- `confidenceGate(ctx, project, issue, labels, stage, score)` — records the
  entry and returns `{ action: "proceed" }` or
  `{ action: "hold", reason: string }`.

Call sites in `loop/supervise.ts` and `loop/finish.ts`:

| Stage | Where | Below threshold |
| --- | --- | --- |
| `code` | worker returns `completed`, **before** `machineReviewGate` | hold; the reviewer never runs, nothing is pushed, no PR |
| `plan` | plan returns `completed`, before `planReviewGate` | hold; no child issues filed, epic stays out of `fleet:review` |
| `machine-review` | reviewer result, alongside the existing verdict handling | hold |
| `plan-review` | reviewer result, same | hold |
| `triage` | `finishTriaged`, replacing the inline comparison at `finish.ts:341` | hold; not promoted to `fleet:ready` |

For triage, `proceed` means "promote to `fleet:ready`" and `hold` means the
existing `swapLabel(inProgress → needsInput)` path it already takes
(`finish.ts:381-382`) — so the behavior it has today is preserved, expressed
through the shared gate. The other two triage hold reasons (body edited
mid-run, `blocked`) are untouched and still short-circuit before the gate.

#### Ordering: gate before the reviewer

Today `machineReviewGate` runs first and `finishCompleted` second
(`supervise.ts:89-97`), so nothing is pushed either way — but a reviewer session
is paid for before any hold. Gating code confidence *before* the reviewer avoids
that spend. The tradeoff is deliberate: a low-confidence result never gets
reviewer findings, so the hold comment carries the worker's own `summary` and
`blockedReason` instead. Stopping early is what the gate is for; a reviewer's
opinion of work its author does not trust is not worth its cost.

#### Holding

Holding reuses the existing blocked path rather than introducing a new terminal
state. The ticket is labeled `fleet:needs-input`, the status comment is updated
to name the stage, its score, the threshold, and the result's own `summary`, and
the session is held open for `replyWaitMinutes` and remains resumable afterward
via `resume: sessionId`. Replying from the dashboard steers the still-live
session exactly as it does for a worker-reported `blocked`, so this adds no new
operator workflow.

Recording happens before the threshold comparison, so a held ticket's score is
visible in the dashboard as soon as it is held.

#### Override: `fleet:confidence-overridden`, consumed on use

Without an override the gate deadlocks. An operator who reviews a 65% result,
judges it correct, and replies "this is good, proceed" gets a resumed session
that re-scores itself at 68% and is held again — indefinitely, since the only
alternative is lowering the project-wide threshold for every ticket. Nothing in
fleet bypasses a hold today; the closest affordance is `finishFailed`'s own
advice to "re-label `fleet:ready` to retry" (`finish.ts:456`), which restarts
rather than accepts.

The operator applies `fleet:confidence-overridden` to the issue. The gate reads
it from the live issue labels — already re-fetched on every resume
(`runner.ts:245-252`) — and when present:

1. Removes the label from the issue **first**.
2. Records the entry with `overridden: true` and the real `threshold`.
3. Returns `proceed`.

**The override is single-use.** Removing the label is what consumes it, so a
later stage on the same ticket gates normally: an overridden 65% code result
proceeds to the machine reviewer, and if the reviewer then scores 40% the ticket
holds. That is the requirement — the flag resets, and each stage must clear the
bar on its own merits or be overridden again deliberately.

Removal happens before proceeding so the gate **fails closed**: if
`removeLabel` throws, the gate holds rather than proceeding, because proceeding
with the label still attached would silently convert a single-use override into
a permanent one for that ticket.

#### Resume context

`reply()` sends only the operator's raw message text (`operator.ts:62-102`), and
`resumeTicket` passes it verbatim as `firstMessage` (`runner.ts:264-275`). The
resumed SDK session retains its own history, so the agent remembers *scoring*
65% — but nothing tells it that the score is why it stopped, which is the other
half of the deadlock above.

`loop/confidence.ts` therefore exports a `confidenceHoldPreamble(entry, waived)`
prepended to the resume message whenever the ticket's last terminal event was a
confidence hold:

- Not waived: names the stage, the score, and the threshold, and instructs the
  agent to address the specific uncertainty rather than restate the work.
- Waived (the override consumed this cycle): states that a human reviewed the
  result and waived the gate, and that the agent should proceed to completion
  rather than hedge into another low score.

This mirrors the existing `STALL_NUDGE` constant (`recovery.ts:8-12`) — a fixed
preamble concatenated ahead of the operator's own text, not a replacement for it.

#### Reviewer confidence inverts one existing contract, deliberately

The machine reviewer currently fails **open**: any reviewer failure sends the
ticket on to human review rather than blocking it (`session/review.ts`, catch at
`supervise.ts:250-252`). Gating on reviewer confidence inverts that for one
specific case — a review that completed but reports low confidence in its own
judgment.

This is intended. A review the reviewer does not trust is exactly the case that
warrants a human, and `fleet:needs-input` is where a human looks. Fail-open
remains in force for every other reviewer failure mode: crashes, timeouts, and
unparseable output still pass the ticket through to human review as they do
today.

#### Triage stamps a null threshold when auto-promote is disabled

With `triageAutoPromote: false` the score is informational: the ticket holds
regardless, so there is no bar it can be said to have missed. Stamping the real
threshold would paint every such badge red on a project that deliberately
reviews every triage by hand. Triage therefore stamps `threshold: null` in that
mode, which renders neutral — "recorded, not gated" — and the shared gate skips
the comparison entirely rather than special-casing a sentinel number.

### 5. Dashboard

No new plumbing is needed for either surface. `getBoard` attaches the whole
`TicketRecord` to active tickets (`loop/board.ts:50-56`) and
`synthesizeDoneTickets` attaches the `ClosedTicketRecord` — which extends
`TicketRecord` — to Done ones (`loop/board.ts:44`). So `confidenceHistory`
reaches every card and the detail panel already, and each entry carries its own
threshold. `BoardTicket` is unchanged.

A shared `ConfidenceBadge.vue` renders one entry in two sizes, so the color rule
and score formatting live in one place:

- `threshold === null` — neutral gray (recorded, not gated)
- `score >= threshold` — green
- `score < threshold` — red
- `overridden` — green regardless, with a marker distinguishing it from a score
  that passed on its own

`packages/dashboard/src/components/TicketDetail.vue`: the badge in the header
block, immediately above the meta row at `:306`, showing the most recent entry
labeled with its stage (`Code 91%`). Clicking it expands the full trail in
order: `Triage 88% → Code 91% → Review 74%`.

`packages/dashboard/src/components/TicketCard.vue`: the compact badge alongside
the existing plan/triage badges at `:91-92`, showing the latest entry's score
only (`91%`) — the card is dense and the stage is largely implied by the column.
This applies to every column, Done included: a closed ticket's badge is the last
score it ever recorded, which is the "how sure was the agent about the thing that
shipped?" number.

#### The trail is a list, not a set of stage slots

Render exactly the entries present, in recorded order. There are no placeholder
slots for absent stages, so `Code 91% → Review 74%` with no origin step is a
complete and correct rendering, not a degraded one — and nothing needs to align
around a gap.

This matters because partial trails are the norm, not an edge case: a ticket
mid-flight during the deploy develops a `code` entry with no `triage` or `plan`
entry before it, and most tickets never pass through every stage anyway. A
stage-keyed implementation would invent empty slots for stages that were never
supposed to run.

A ticket with no `confidenceHistory` at all renders no badge on either surface —
the normal state for every ticket predating the field, so both surfaces degrade
silently rather than showing a zero or a placeholder.

### 6. Testing

- `packages/shared/src/index.test.ts` — the four changed/extended schemas:
  integer 0–100 accepted, out-of-range and non-integer rejected, review schemas
  require the new field, and each legacy string coerces to its mapped number.
- `packages/daemon/src/loop/confidence.test.ts` (new) — `recordConfidence`
  appends rather than replaces and preserves order; the `belowThreshold`
  boundary (a score exactly equal to the threshold proceeds); a `null` threshold
  never holds; the override path removes the label, marks the entry
  `overridden`, and proceeds; a `removeLabel` failure holds instead of
  proceeding; the override does not apply to a second gate on the same ticket.
- Config tests: a config still carrying `triageAutoPromoteThreshold` fails to
  load with a message naming `confidenceThreshold` and `triageAutoPromote`.
- Triage gate tests, adapted from the existing auto-promote tests: at or above
  the threshold promotes to `fleet:ready`; below it holds in
  `fleet:needs-input`; `triageAutoPromote: false` always holds and stamps a null
  threshold; `fleet:confidence-overridden` promotes a would-be-held triage; the
  body-edited and `blocked` hold reasons still short-circuit before the gate.
- Additions to the existing finish/supervise tests, one pair per gated stage:
  above threshold proceeds normally; below threshold holds, applies
  `fleet:needs-input`, and asserts nothing was pushed, no PR opened, and for the
  plan path no child issues filed. Plus one asserting a below-threshold code
  result never invokes the machine reviewer.
- A resume test: a ticket held on confidence gets the hold preamble ahead of the
  operator's text, and the waived variant when the override was consumed.
- A `ConfidenceBadge` render test: color across the stamped threshold including
  the boundary (equal renders green), the null-threshold neutral case, and the
  overridden marker.
- A `TicketDetail` render test: badge shows the latest entry with its stage,
  expansion lists the whole trail, a partial trail renders without gaps, absent
  history renders nothing.
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
- Backfilling `confidenceHistory` for existing tickets.
- A dashboard button for the override. Applying
  `fleet:confidence-overridden` from the issue is the v1 affordance; a
  one-click dashboard action is a natural follow-up once the flow is proven.
