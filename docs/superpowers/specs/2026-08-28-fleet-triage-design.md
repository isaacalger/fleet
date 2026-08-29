# Fleet triage: turning unlabeled issues into specs

## Problem

Fleet only acts on issues carrying a `fleet:*` label. `listFleetIssues`
(`packages/daemon/src/github/github.ts:79`) fetches every open issue each cycle,
then discards any without that prefix. An issue filed the ordinary way — say
`isaacalger/Snake#4`, labeled only `bug` — is invisible to both the daemon and
the dashboard. There is no surface where a human can see what fleet is ignoring.

Separately, a hand-written bug report is rarely ready for a coding worker. It
describes a symptom, not a root cause, and usually lacks the
problem/acceptance-criteria/verification structure that intake lint requires.
Promoting such an issue straight to `fleet:ready` produces an immediate
`fleet:needs-input` bounce.

This design adds a triage stage in front of the coding stage: an agent
investigates the symptom, produces a root-cause diagnosis and a well-formed
spec, and reports how confident it is. Specs above a configurable confidence
threshold are promoted to real work automatically; the rest wait for a human.

## Scope

In scope: a dashboard surface for non-fleet issues, a `triage` ticket kind, its
structured-output contract, its terminal path, per-project config, and vendoring
the `systematic-debugging` skill into target repos.

Out of scope: changing how coding or plan tickets work; webhook-based issue
pickup (60s polling is adequate); any change to `settingSources`.

## Architecture

### Triage panel

`listFleetIssues` splits into a raw `listOpenIssues(project)` plus two filters
over the same result, so surfacing non-fleet issues costs no additional `gh`
call.

- `GET /api/triage` returns, per project, open issues with no `fleet:*` label:
  number, title, body, labels, author, url, and any stored triage result.
- `POST /api/triage/:project/:issue/investigate` starts a triage.
- The dashboard gains a **Triage** section, deliberately not a board column.
  These issues have no fleet status; `boardStatusFromLabels` returning `null` is
  precisely what excludes them today. Adding a `BoardStatus` member for them
  would contaminate the state model for no gain.

### Triage runs as a ticket, not a side channel

The Investigate button does not start a session. It adds a new `fleet:triage`
label to the issue. The ordinary claim loop picks it up on the next cycle,
exactly as it does for `fleet:plan`.

This keeps GitHub labels as the single source of truth and means triage inherits
claiming, `maxConcurrent`, `maxInReview`, the rolling spend budget, work-hours
reserve, stall recovery, the plan usage-limit pause, journals, and per-model cost
tracking without new coordination code.

`kind: "triage"` joins `"code"` and `"plan"` in `loop/runner.ts`. The session is
read-only, enforced by the existing `denyForbiddenPlanBash` hook, which already
denies `git commit` on top of the push/PR/label restrictions. No new enforcement
point is introduced.

`fleet:triage` is added to `ALL_FLEET_LABELS` so `init-labels` creates it.

### Contract

`TriageResultSchema` in `packages/shared/src/contracts.ts`:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"completed" \| "blocked"` | blocked = a human decision is needed before diagnosis can proceed |
| `summary` | string | 2–5 sentences for the status comment |
| `rootCause` | string | The diagnosis: what is actually wrong, not the symptom |
| `evidence` | string[] | `file:line` references supporting the diagnosis |
| `confidence` | integer 0–100 | Percentage confidence in the root cause and spec |
| `spec.problem` | string | Body content under `## Problem` |
| `spec.acceptanceCriteria` | string | Body content under `## Acceptance criteria` |
| `spec.verification` | string | Body content under `## Verification` |
| `suggestedTier` | `"light" \| "standard" \| "elevated"` (optional) | Model tier for the follow-on coding ticket |
| `blockedReason` | string (optional) | Required when status is blocked |

`spec` is rendered into the issue body under exactly those three headings, so a
promoted issue passes intake lint. That mismatch is what makes issue #4 fail
today: its third heading is `## Expected`, which is not among the verification
synonyms.

**Deliberate divergence.** `WorkerResultSchema` and `PlanResultSchema` both use
`confidence: enum(["low","medium","high"])`. Triage uses an integer percentage
because a configurable threshold requires ordering. Model self-reported
confidence is poorly calibrated — 82 versus 78 is not a meaningful distinction —
so `triageConfidence` is persisted on `TicketRecord` alongside the ticket's
eventual outcome, letting the threshold be tuned against observed results rather
than guessed at.

### Terminal path

`finishTriaged` in `loop/finish.ts`:

1. Post root cause, evidence, and confidence to the issue's status comment.
2. Append the rendered spec to the issue body via the existing
   `updateIssueBody`.
3. Branch:
   - `status === "completed"` and `confidence >= triageAutoPromoteThreshold`:
     swap `fleet:triage` for `fleet:ready`, plus the suggested tier label. A
     coding worker claims it on a later cycle.
   - Below threshold: swap `fleet:triage` for `fleet:needs-input`. A human
     decides from the dashboard.
   - `blocked`, or any session error: `fleet:needs-input`.

**Failure must never increase autonomy.** Machine review fails open — a reviewer
crash lets the ticket proceed to human review. Triage fails closed: a crashed or
blocked triage never promotes. The asymmetry is intentional, because the
downstream consequence differs. A failed review costs a missed check; a failed
triage that promoted anyway would start an unsupervised coding session on an
undiagnosed bug.

### Config

Per project, in `ProjectConfigSchema`:

- `triage: boolean`, default `false`. Off until explicitly enabled.
- `triageAutoPromoteThreshold: integer 0–101`, default `80`. The comparison is
  `confidence >= threshold`, so `0` promotes everything and `101` — above any
  reportable confidence — never promotes, leaving triage as a pure
  spec-writing step.

Per the `config-shape-change` skill, three places change together: the schema in
`packages/shared/src/config.ts`, `fleet.config.example.json`, and the config
test.

### Vendoring systematic-debugging

Worker sessions run with `settingSources: ["project"]`
(`session/worker.ts:414`), which loads only the target repo's `.claude/` — not
user-level plugins. `superpowers:systematic-debugging` therefore is not
reachable from a worker session as things stand.

`templates/systematic-debugging/SKILL.md` holds a copy carrying a provenance
header naming its upstream source and version. `sync-templates` stamps it into
each project's `.claude/skills/`, the same mechanism already used for
`fleet-backlog`. The triage prompt instructs the session to invoke it.

`settingSources` is left unchanged. Widening it to `["user", "project"]` would
pull the operator's entire local plugin set into every worker session — a large,
machine-specific, non-reproducible surface, and a change that would affect coding
sessions too, not just triage.

The copy can drift from upstream. That is accepted: it is versioned with the
repo, reviewable in a diff, and re-stamped by `sync-templates` on demand — the
same trade already made for `fleet-backlog`.

## Data flow

```
issue labeled `bug` (no fleet:*)
  └─> GET /api/triage            → Triage panel
       └─> Investigate           → add `fleet:triage`
            └─> claim loop       → kind: "triage", read-only session
                 └─> systematic-debugging → TriageResult
                      ├─ completed && confidence >= threshold
                      │    └─> body += spec; label fleet:ready (+ tier)
                      │         └─> ordinary coding worker → PR
                      └─ otherwise
                           └─> body += spec; label fleet:needs-input
```

## Error handling

| Case | Behavior |
|---|---|
| Session errors | `fleet:needs-input`; never promoted |
| Result is `blocked` | Question posted, `fleet:needs-input`, session held for reply per existing `replyWaitMinutes` |
| Confidence below threshold | `fleet:needs-input`; not a failure, spec still written to the body |
| `updateIssueBody` fails | Log, post the spec to the status comment instead, do not promote |
| Issue already carries a `fleet:*` label | Investigate is rejected; it is not a triage candidate |
| Existing auto-elevate on failure | Applies unchanged; a triage that errors retries once on `elevatedModel` |

## Testing

`packages/daemon/src/loop/loop.triage.test.ts`, following the existing
per-behavior test-file pattern and using the shared fixture factories in
`test-support.ts`:

- A `fleet:triage` issue claims as `kind: "triage"`
- Confidence at the threshold promotes (boundary is `>=`)
- Confidence below threshold lands in `fleet:needs-input`
- A blocked result lands in `fleet:needs-input`
- A session error does not promote
- `git commit` is denied in a triage session
- `triage: false` means a `fleet:triage` issue is never claimed
- The promoted body passes `lintIntake`

Plus a contract test for `TriageResultSchema`, and a `sync-templates` test
asserting the vendored skill is written.

## Risks

**Chained autonomy.** Auto-promotion links two agent sessions with no human
between them; a confidently wrong root cause becomes a confidently wrong PR. PR
review remains the backstop, and nothing merges without a human unless
`autoMerge` is separately enabled. `triage: false` by default and a threshold of
80 are the mitigations.

**Confidence calibration.** The threshold is only as good as the model's
self-assessment. Persisting confidence against outcome makes this measurable
rather than a permanent guess.

**State machine surface.** This touches `runner`, `supervise`, `finish`, the
board projection, and the config schema. It is the cost of reusing the pipeline
rather than building a parallel one, and the per-behavior test files are what
keep it honest.
