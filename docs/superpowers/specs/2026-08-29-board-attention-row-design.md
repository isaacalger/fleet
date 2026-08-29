# Board: a "Needs attention" second row

The board becomes two rows. The top row is the conveyor a ticket rides on its
own — Ready → In progress → In review → Done. The bottom row is one merged
**Needs attention** column holding everything stopped waiting on a human:
`fleet:needs-input` tickets and untriaged `fleet:triage` tickets.

## Motivation

Two problems with the current five-column single row.

**Needs input is not a stage.** It sits between In progress and In review as if
tickets flow through it, but nothing flows through it on its own — it is
terminal until a human acts (`recoverStalled` only picks `stalled` records;
`selectEligibleReady` excludes needs-input). Putting it inline implies a
progression that does not exist, and it splits the conveyor in half.

**Triage is hidden in Ready.** `boardStatusFromLabels` maps `fleet:triage` to
`"ready"` last (`labels.ts:47-57`), so untriaged tickets pile into the Ready
column and are distinguishable only by the badge added in `c1d0c72`. But a
`fleet:triage` ticket is not ready work — it is an unspecified problem someone
filed, waiting for investigation. It belongs with the other things asking for
attention, at a different point in the process.

Both are "stopped, awaiting a human". Grouping them off the main flow makes the
top row read as actual progress and gives the operator one place to look.

## Design

### 1. `triage` becomes its own board status

`packages/shared/src/board.ts`:

```ts
export type BoardStatus = "ready" | "triage" | "in-progress" | "needs-input" | "review" | "done";
```

`boardStatusFromLabels` (`packages/shared/src/labels.ts:47-57`) maps
`fleet:triage` to `"triage"` instead of `"ready"`. The precedence order is
otherwise unchanged, and specifically `fleet:in-progress` still wins over
`fleet:triage` — so a triage session **that is actively running shows in In
progress**, on the top row. It is being worked and asks nothing of the operator.
Only unclaimed triage tickets land in the attention row; held ones are already
`fleet:needs-input`.

This is safe for daemon behavior. `boardStatusFromLabels` has exactly one
non-test caller — `github.ts:120`, stamping `BoardTicket.status` for display.
Claiming, gating, and recovery all read labels and record status directly, never
board status.

**The two statuses stay distinct in the data model and merge only in
presentation.** Mapping `fleet:triage` straight to `"needs-input"` would render
identically today and be wrong: a needs-input ticket is unclaimable and never
auto-resumed, while a `fleet:triage` ticket is ordinary claimable work. Any
future code reading `status === "needs-input"` would be misled by the
conflation.

### 2. Columns become rows

`BOARD_COLUMNS` currently pairs one title to one status. It becomes a list of
columns that each render one *or more* statuses, tagged with a row:

```ts
export const BOARD_COLUMNS: {
  key: string;
  title: string;
  statuses: BoardStatus[];
  row: 1 | 2;
}[] = [
  { key: "ready",       title: "Ready",           statuses: ["ready"],                  row: 1 },
  { key: "in-progress", title: "In progress",     statuses: ["in-progress"],            row: 1 },
  { key: "review",      title: "In review",       statuses: ["review"],                 row: 1 },
  { key: "done",        title: "Done",            statuses: ["done"],                   row: 1 },
  { key: "attention",   title: "Needs attention", statuses: ["needs-input", "triage"],  row: 2 },
];
```

`STATUS_ACCENTS` in the dashboard is re-keyed from status to column `key`, since
a column can now cover two statuses.

### 3. Rendering

`packages/dashboard/src/App.vue`: the single `flex` strip at `:312-321` becomes
two stacked strips, one per row, filtered from the same `BOARD_COLUMNS`. The
top row keeps today's equal-width flex behavior across four columns instead of
five; the attention row is one full-width column whose cards wrap.

The grouping computation at `App.vue:77` keys by column rather than status, so a
column with two statuses collects both.

**Ordering inside the attention column:** `needs-input` tickets first, then
`triage`, each by issue number. Blocked work is a stronger claim on the
operator's time than an uninvestigated report, and a stable order stops cards
jumping between polls.

**Empty state:** when both statuses are empty the entire second row is hidden
rather than rendered as an empty column. The common steady state is nothing
needing attention, and a permanent empty strip trains the operator to ignore
that region — which is the one region that must never be ignored.

Cards keep the existing triage badge (`TicketCard.vue:91-92`), so the two kinds
remain distinguishable inside the merged column without a second count.

### 4. Interaction with the confidence work

Confidence holds land in `fleet:needs-input`, so they appear in this row. The
confidence badge specified in
`2026-08-29-pipeline-confidence-design.md` renders on these cards like any
other — a held ticket showing `65%` in red next to a `question` card is exactly
the intended reading of the row. The two designs are otherwise independent and
can ship in either order.

## Testing

- `packages/shared/src/index.test.ts` — `boardStatusFromLabels` returns
  `"triage"` for a `fleet:triage` issue, and still `"in-progress"` when both
  labels are present.
- An `App.vue` board-grouping test: a ticket of each status lands in the right
  column; the attention column collects both statuses; ordering puts
  needs-input ahead of triage; the second row is absent when both are empty.
- Existing board tests that assert a triage ticket appears in Ready are updated
  to expect the attention row — the change in `c1d0c72` is being superseded, not
  reverted, since the distinguishing badge it added is what keeps the merged
  column readable.

Verification is `pnpm typecheck` and `pnpm test`, plus loading the dashboard per
the `verify` skill — this is a layout change, so it needs to be looked at.

## Out of scope

- Any change to what triage *does*: claiming, the triage session, promotion, and
  hold behavior are untouched. This is presentation only.
- Separate counts or filters for triage vs needs-input within the merged column.
- Reordering or restyling the top row beyond absorbing the freed width.
