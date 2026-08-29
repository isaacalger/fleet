# Board Attention Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the board into two rows — a top conveyor (Ready → In progress → In review → Done) and a bottom full-width "Needs attention" column collecting `needs-input` and unclaimed `triage` tickets.

**Architecture:** `triage` becomes its own `BoardStatus` so the data model stays honest, and the two statuses merge only in presentation. `BOARD_COLUMNS` grows from one-status-per-column to `{ key, title, statuses[], row }`, and `App.vue` renders two stacked strips from it. No daemon behavior changes: `boardStatusFromLabels` has exactly one non-test caller and it only stamps a display field.

**Tech Stack:** TypeScript (ESM, `.ts` import extensions), Vue 3 + Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-board-attention-row-design.md`

**Relationship to the confidence work:** independent. Confidence holds land in `fleet:needs-input` and so appear in this row, and `TicketCard.vue` is touched by both — but neither blocks the other. If both are in flight, land the confidence plan first to avoid a conflict in `TicketCard.vue`.

---

## Required reading

- `.claude/skills/write-tests/SKILL.md` — fixture factories and assertion conventions

Run `pnpm typecheck && pnpm test` first to confirm a green baseline.

## File Structure

**Modified:**
- `packages/shared/src/board.ts` — `BoardStatus` gains `"triage"`; `BOARD_COLUMNS` reshapes to carry statuses and a row
- `packages/shared/src/labels.ts` — `boardStatusFromLabels` maps `fleet:triage` to `"triage"`
- `packages/dashboard/src/App.vue` — two stacked row strips; grouping keys by column instead of status
- `packages/shared/src/index.test.ts` — label mapping tests

---

### Task 1: `triage` becomes its own board status

**Files:**
- Modify: `packages/shared/src/board.ts:3` (`BoardStatus`)
- Modify: `packages/shared/src/labels.ts:47-57` (`boardStatusFromLabels`)
- Test: `packages/shared/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("boardStatusFromLabels with triage", () => {
  it("maps a fleet:triage issue to the triage status", () => {
    expect(boardStatusFromLabels(["fleet:triage"])).toBe("triage");
  });

  it("still reads as in-progress mid-claim, when both labels are attached", () => {
    expect(boardStatusFromLabels(["fleet:triage", "fleet:in-progress"])).toBe("in-progress");
  });

  it("still reads as needs-input once a triage is held", () => {
    expect(boardStatusFromLabels(["fleet:triage", "fleet:needs-input"])).toBe("needs-input");
  });
});
```

Then update any existing test asserting `boardStatusFromLabels(["fleet:triage"]) === "ready"` to expect `"triage"`. Search for it: `grep -rn '"fleet:triage"' packages/shared/src/index.test.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run --root . packages/shared -t "boardStatusFromLabels with triage"`
Expected: FAIL — returns `"ready"`.

- [ ] **Step 3: Widen the type and the mapping**

In `packages/shared/src/board.ts:3`:

```ts
export type BoardStatus = "ready" | "triage" | "in-progress" | "needs-input" | "review" | "done";
```

In `packages/shared/src/labels.ts`, change the last branch of `boardStatusFromLabels` (keeping its position last and updating the comment, which currently explains the `"ready"` fallback):

```ts
  // Last, so it can never shadow a more specific state: an issue mid-claim
  // briefly carries both `fleet:triage` and `fleet:in-progress`, and a held
  // triage carries `fleet:needs-input` — both must win over this.
  if (labels.includes(TRIAGE_LABEL)) return "triage";
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run --root . packages/shared && pnpm typecheck`
Expected: PASS. If typecheck flags an exhaustive `switch` or `Record<BoardStatus, …>` somewhere (likely `STATUS_ACCENTS` in the dashboard), that is Task 2's surface — note it and continue.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/board.ts packages/shared/src/labels.ts packages/shared/src/index.test.ts
git commit -m "feat(board): give triage its own board status instead of folding it into ready"
```

**Why this is safe:** `boardStatusFromLabels` has exactly one non-test caller, `packages/daemon/src/github/github.ts:120`, which stamps `BoardTicket.status` for display. Claiming, gating, and recovery read labels and record status directly. Verify with `grep -rn boardStatusFromLabels packages/` before you start, and if you find a second caller, STOP and report it.

---

### Task 2: Columns carry statuses and a row

**Files:**
- Modify: `packages/shared/src/board.ts:5-11` (`BOARD_COLUMNS`)
- Modify: `packages/dashboard/src/App.vue:4,77,312-321`
- Test: `packages/dashboard/src/App.test.ts` (create if the grouping isn't already covered — check first)

- [ ] **Step 1: Write the failing test**

Test the grouping logic. If `byStatus` at `App.vue:77` is inline, extract it to an exported pure function first (e.g. `groupTicketsByColumn(tickets)` in `packages/dashboard/src/lib/board.ts`) so it can be tested without mounting — that extraction is in scope.

```ts
import { groupTicketsByColumn } from "../lib/board.ts";

const t = (status: BoardStatus, issueNumber: number) => ({ project: "demo", issueNumber, title: "t", url: "", status, priority: null, type: null, isPlan: false, isTriage: status === "triage" });

describe("groupTicketsByColumn", () => {
  it("puts each main-row status in its own column", () => {
    const groups = groupTicketsByColumn([t("ready", 1), t("in-progress", 2), t("review", 3), t("done", 4)]);
    expect(groups.get("ready")?.map((x) => x.issueNumber)).toEqual([1]);
    expect(groups.get("in-progress")?.map((x) => x.issueNumber)).toEqual([2]);
  });

  it("collects both needs-input and triage into the attention column", () => {
    const groups = groupTicketsByColumn([t("triage", 5), t("needs-input", 6)]);
    expect(groups.get("attention")?.map((x) => x.issueNumber)).toEqual([6, 5]);
  });

  it("orders needs-input ahead of triage, then by issue number", () => {
    const groups = groupTicketsByColumn([t("triage", 3), t("needs-input", 9), t("triage", 1), t("needs-input", 2)]);
    expect(groups.get("attention")?.map((x) => x.issueNumber)).toEqual([2, 9, 1, 3]);
  });

  it("leaves the attention column empty when nothing needs attention", () => {
    expect(groupTicketsByColumn([t("ready", 1)]).get("attention")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run --root . packages/dashboard -t "groupTicketsByColumn"`
Expected: FAIL — module or export missing.

- [ ] **Step 3: Reshape `BOARD_COLUMNS`**

In `packages/shared/src/board.ts`:

```ts
export const BOARD_COLUMNS: {
  key: string;
  title: string;
  statuses: BoardStatus[];
  row: 1 | 2;
}[] = [
  { key: "ready",       title: "Ready",           statuses: ["ready"],                 row: 1 },
  { key: "in-progress", title: "In progress",     statuses: ["in-progress"],           row: 1 },
  { key: "review",      title: "In review",       statuses: ["review"],                row: 1 },
  { key: "done",        title: "Done",            statuses: ["done"],                  row: 1 },
  // Merged deliberately: both mean "stopped, waiting on a human". They stay
  // distinct statuses because a needs-input ticket is unclaimable while a
  // fleet:triage one is ordinary claimable work.
  { key: "attention",   title: "Needs attention", statuses: ["needs-input", "triage"], row: 2 },
];
```

- [ ] **Step 4: Write the grouping function**

Create `packages/dashboard/src/lib/board.ts`:

```ts
import { BOARD_COLUMNS, type BoardTicket } from "@fleet/shared";

/**
 * Group tickets by board column. A column may cover more than one status (the
 * attention row), in which case tickets are ordered by the column's own status
 * order first — blocked work is a stronger claim on the operator's time than an
 * uninvestigated report — then by issue number, so cards don't jump between polls.
 */
export function groupTicketsByColumn(tickets: BoardTicket[]): Map<string, BoardTicket[]> {
  const groups = new Map<string, BoardTicket[]>(BOARD_COLUMNS.map((c) => [c.key, []]));
  for (const column of BOARD_COLUMNS) {
    const bucket = groups.get(column.key)!;
    for (const status of column.statuses) {
      bucket.push(...tickets.filter((t) => t.status === status).sort((a, b) => a.issueNumber - b.issueNumber));
    }
  }
  return groups;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run --root . packages/dashboard -t "groupTicketsByColumn"`
Expected: PASS, 4 tests.

- [ ] **Step 6: Render two rows**

In `App.vue`, replace the `byStatus` computed at `:77` with a call to `groupTicketsByColumn`, re-key `STATUS_ACCENTS` from status to column `key` (adding an `attention` accent — reuse the existing needs-input color), and replace the single strip at `:312-321` with two:

```vue
<div class="flex min-h-0 flex-1 gap-3 overflow-x-auto">
  <BoardColumn
    v-for="column in BOARD_COLUMNS.filter((c) => c.row === 1)"
    :key="column.key"
    :title="column.title"
    :count="byColumn.get(column.key)?.length ?? 0"
    :accent="STATUS_ACCENTS[column.key]"
  >
    <TicketCard
      v-for="ticket in byColumn.get(column.key)"
      :key="`${ticket.project}#${ticket.issueNumber}`"
      :ticket="ticket"
      :selected="ui.isSelected(ticket)"
      :pending-approvals="approvalCounts.get(`${ticket.project}#${ticket.issueNumber}`) ?? 0"
    />
  </BoardColumn>
</div>
<!-- Hidden entirely when empty: the steady state is nothing needing attention,
     and a permanent empty strip trains the operator to ignore the one region
     that must never be ignored. -->
<div v-if="attentionTickets.length > 0" class="mt-3 flex shrink-0">
  <BoardColumn
    title="Needs attention"
    :count="attentionTickets.length"
    :accent="STATUS_ACCENTS.attention"
    class="w-full"
  >
    <div class="flex flex-wrap gap-2">
      <TicketCard
        v-for="ticket in attentionTickets"
        :key="`${ticket.project}#${ticket.issueNumber}`"
        :ticket="ticket"
        :selected="ui.isSelected(ticket)"
        :pending-approvals="approvalCounts.get(`${ticket.project}#${ticket.issueNumber}`) ?? 0"
      />
    </div>
  </BoardColumn>
</div>
```

with:

```ts
const byColumn = computed(() => groupTicketsByColumn(filteredTickets.value));
const attentionTickets = computed(() => byColumn.value.get("attention") ?? []);
```

Use whatever the existing computed is actually named for the project-filtered ticket list rather than `filteredTickets` — read the file. `BoardColumn` may need to accept a `class` passthrough or a width prop for the full-width case; if its current markup fixes a width, adjust it minimally rather than restructuring the component.

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS all three.

Then look at it: `pnpm daemon` and open `http://localhost:4400`. Confirm the top row spreads across four columns, that a `fleet:triage` ticket appears in the bottom row rather than Ready, and that the bottom row disappears when nothing is in it. This is a layout change — it must be seen, not just tested.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/board.ts packages/dashboard/src/
git commit -m "feat(dashboard): move needs-input and triage into a merged attention row"
```

---

### Task 3: Verification

- [ ] **Step 1:** `pnpm typecheck && pnpm test && pnpm build` — all green.
- [ ] **Step 2:** `grep -rn '"ready"' packages/shared/src/labels.ts` — confirm no leftover triage-to-ready mapping.
- [ ] **Step 3:** Read `.claude/skills/verify/SKILL.md` and run anything it lists that this plan missed.
- [ ] **Step 4:** `git push fork design/fleet-triage`

## Out of scope

- Any change to what triage does — claiming, the session, promotion, hold behavior. Presentation only.
- Separate counts or filters for triage vs needs-input inside the merged column.
- Restyling the top row beyond absorbing the freed width.
