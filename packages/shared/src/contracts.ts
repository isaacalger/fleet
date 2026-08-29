import { z } from "zod";

/** A calibrated 0-100 confidence percentage. */
export const ConfidenceScoreSchema = z.number().int().min(0).max(100);

/**
 * TRANSITIONAL: maps the pre-migration `low|medium|high` confidence strings
 * onto the 0-100 scale, applied to a session's raw structured output *before*
 * it reaches zod.
 *
 * This lives outside the schema deliberately. A `z.union`/`z.transform` in the
 * schema itself makes `z.toJSONSchema` throw ("Transforms cannot be
 * represented in JSON Schema"), and the daemon builds its `outputFormat` from
 * these schemas at module load — so the union would stop the daemon booting.
 * Normalizing here keeps the advertised schema honest (a number, matching what
 * the prompts now ask for) while still rescuing sessions that predate the
 * change: a daemon restart resumes running tickets into their *existing* SDK
 * sessions, whose context still contains the old instruction, and an
 * unparseable result is an errored turn that burns the ticket's once-only
 * auto-elevate on a retry that cannot succeed.
 *
 * Remove one full ticket-lifetime after deploy.
 */
export function normalizeLegacyConfidence<T>(raw: T): T {
  if (raw === null || typeof raw !== "object" || !("confidence" in raw)) return raw;
  const { confidence } = raw as { confidence: unknown };
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return raw;
  const score = confidence === "high" ? 90 : confidence === "medium" ? 60 : 30;
  return { ...raw, confidence: score };
}

export const WorkerResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = work is committed and ready for a PR; blocked = a human decision is needed before work can continue"),
  summary: z.string().describe("2-5 sentence plain-language summary of what was done (or attempted), written for the ticket's status comment"),
  filesChanged: z.array(z.string()).describe("Repo-relative paths of files created or modified"),
  prTitle: z.string().optional().describe("Conventional-commit style title for the PR (required when status is completed)"),
  prBody: z.string().optional().describe("PR description in markdown: what changed, why, and how it was verified (required when status is completed)"),
  blockedReason: z.string().optional().describe("The specific question or decision a human must answer (required when status is blocked)"),
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are that the change is correct and complete. Be honest and calibrated: 90+ means you verified it end to end; below 50 means you are guessing. A score below the project threshold stops the ticket for human review instead of opening a PR, so overstating it causes real harm."),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const MachineReviewResultSchema = z.object({
  verdict: z.enum(["pass", "findings"]).describe("pass = the diff is ready for human review; findings = the worker should do one fix round first"),
  summary: z.string().describe("1-3 sentence overall assessment of the diff, written for the ticket's status comment"),
  findings: z.array(z.object({
    file: z.string().describe("Repo-relative path of the file the finding is in"),
    line: z.number().int().optional().describe("Line number the finding anchors to, if known"),
    severity: z.enum(["blocker", "major", "minor"]).optional().describe("blocker = must not ship; major = real defect; minor = worth fixing while we're here"),
    summary: z.string().describe("One-sentence statement of the defect"),
    detail: z.string().describe("Why it's wrong and what a fix needs to do"),
  })).default([]).describe("Concrete, actionable defects only — empty when verdict is pass"),
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are in this review itself — that you understood the diff and that your verdict is right. Be honest: if the diff touches code you could not fully trace, say so with a low score. A score below the project threshold stops the ticket for human review."),
});
export type MachineReviewResult = z.infer<typeof MachineReviewResultSchema>;

export const PlanResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = tickets[] is ready to file as child issues; blocked = a human decision is needed before this epic can be decomposed"),
  summary: z.string().describe("2-5 sentence plain-language summary of the decomposition (or what's blocking it), written for the plan issue's status comment"),
  tickets: z.array(z.object({
    title: z.string().describe("Concise title for the child ticket"),
    body: z.string().describe("Full issue body for the child ticket, in markdown with a `## Problem`, `## Acceptance criteria`, and `## Verification` heading each — self-contained, independently implementable, and PR-sized"),
    priority: z.enum(["fleet:p1", "fleet:p2", "fleet:p3"]).optional().describe("Priority label to apply to the child issue, if any"),
    tier: z
      .enum(["light", "standard", "elevated"])
      .optional()
      .describe(
        "Suggested model tier for this child ticket, judged honestly by complexity: light = mechanical/small-surface (doc tweaks, renames, simple sweeps), elevated = cross-cutting or design-heavy work, standard = everything else (default)",
      ),
    dependsOnIndex: z
      .array(z.number().int().nonnegative())
      .optional()
      .describe(
        "Indices into this same tickets[] array (0-based) of sibling tickets that must land first. Use sparingly — most tickets should stand alone; only mark a dependency when the epic genuinely requires ordering (e.g. 'add the schema field' before 'use it in the dashboard'). Only earlier indices are honored — a forward or self reference is dropped.",
      ),
  })).describe("Independent, PR-sized child tickets decomposed from this epic; each must be self-contained (problem, acceptance criteria, verification) and independently implementable"),
  blockedReason: z.string().optional().describe("The specific question or decision a human must answer (required when status is blocked)"),
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are that this decomposition is correct and complete. Be honest and calibrated. A score below the project threshold stops the epic for human review instead of filing child tickets, so overstating it causes real harm."),
});
export type PlanResult = z.infer<typeof PlanResultSchema>;

export const PlanReviewResultSchema = z.object({
  verdict: z.enum(["pass", "findings"]).describe("pass = the decomposition is ready to file as child issues; findings = the planner should revise tickets[] first"),
  summary: z.string().describe("1-3 sentence overall assessment of the decomposition, written for the epic's status comment"),
  findings: z.array(z.object({
    ticketIndex: z.number().int().nonnegative().optional().describe("0-based index into tickets[] this finding is about; omit for a finding about the decomposition as a whole (e.g. missing scope)"),
    severity: z.enum(["blocker", "major", "minor"]).optional().describe("blocker = must not file as-is; major = real defect; minor = worth fixing while we're here"),
    summary: z.string().describe("One-sentence statement of the problem"),
    detail: z.string().describe("Why it's a problem and what the planner should change"),
  })).default([]).describe("Concrete, actionable problems only — empty when verdict is pass"),
  confidence: ConfidenceScoreSchema.describe("Whole-number percentage (0-100) expressing how confident you are in this review of the decomposition — that you understood it and that your verdict is right. Be honest: if the decomposition touches areas you could not fully trace, say so with a low score. A score below the project threshold stops the ticket for human review."),
});
export type PlanReviewResult = z.infer<typeof PlanReviewResultSchema>;

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
