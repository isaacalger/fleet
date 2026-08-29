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
 * The bar this stage is judged against, or null when there is no bar at all.
 * Only triage can be ungated, via `triageAutoPromote: false` — the score is
 * still worth keeping, there is just no number it could clear. A null is
 * therefore an unpassable bar, not an absent one: `confidenceGate` holds on it
 * (short of an operator override), so an operator who disabled auto-promotion
 * gets what they asked for no matter which call site runs the gate.
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
  // `StateStore.update` no-ops for a ticket that is no longer in the store (cleaned
  // up mid-flight, or reconciled away by a boot). Returning the entry regardless
  // would silently lose a score from the one module whose job is the audit trail —
  // but throwing would turn a bookkeeping miss into a failed terminal path, so log.
  const updated = ctx.state.update(projectName, issueNumber, { confidenceHistory: [...existing, entry] });
  if (!updated) {
    logError("loop", `${key(projectName, issueNumber)}: no ticket record — confidence entry dropped (${stage} ${score}%)`, undefined);
  }
  return entry;
}

/**
 * Record a stage's score and decide whether it proceeds.
 *
 * Recording happens before the comparison, so a held ticket's score is on the
 * dashboard the moment it is held.
 *
 * Fails **closed** on the failing path, the inverse of `machineReviewGate`: a
 * gh outage or a failed label removal holds rather than proceeding. Proceeding
 * on error would let an unverified score through — and, in the override case,
 * would silently convert a single-use override into a permanent one by leaving
 * the label attached. A score that cleared the bar on its own is the one
 * exception; see the passing branch.
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
  const passes = threshold !== null && score >= threshold;

  // Dry-run decides on score alone: every other gate bails before mutating
  // (`machineReviewGate`, `planReviewGate`), and consuming a real override
  // label during a rehearsal would spend something the operator applied for a
  // real run. Unreachable while `claim.ts` returns before any session opens,
  // but the day dry-run exercises `supervise` this must not surprise anyone.
  if (ctx.dryRun) {
    const entry = record(ctx, project, issueNumber, stage, score, threshold, false);
    return passes ? { action: "proceed" } : { action: "hold", reason: holdReason(stage, score, threshold), entry };
  }

  // Consumed on *every* gate, passing or not. Checking only on the failing path
  // let an override applied for one stage sit on the issue until some later
  // stage happened to fail, silently carrying a gate the operator never meant
  // to waive — the exact leak "single-use" was supposed to prevent.
  let present: boolean;
  try {
    present = await consumeOverride(project, issueNumber);
  } catch (err) {
    if (passes) {
      // The score cleared the bar on its own, so this is failed *cleanup*, not
      // a failed gate: holding here would invent a new way for a gh hiccup to
      // stall a healthy ticket. The label survives, and the next gate that
      // needs it will either consume it or fail closed as usual.
      logError("loop", `${scope}: could not consume the confidence override on a passing ${stage} gate — it may still be attached`, err);
      record(ctx, project, issueNumber, stage, score, threshold, false);
      return { action: "proceed" };
    }
    // Below the bar and we cannot tell whether an override exists, or could not
    // remove one: hold. Proceeding would either leak an unverified score or
    // turn a single-use override into a permanent one.
    logError("loop", `${scope}: could not resolve the confidence override — holding`, err);
    const entry = record(ctx, project, issueNumber, stage, score, threshold, false);
    return { action: "hold", reason: holdReason(stage, score, threshold), entry };
  }

  if (passes) {
    // A label consumed on a passing score is cleanup, not an override: stamping
    // `overridden` here would misreport the trail as "a human waived this".
    if (present) log("loop", `${scope}: cleared a stale confidence override on a passing ${stage} gate (${score}%)`);
    record(ctx, project, issueNumber, stage, score, threshold, false);
    return { action: "proceed" };
  }

  // Below the bar — or, for a null threshold, with no bar the score could ever
  // clear ("recorded, not gated": only triage with `triageAutoPromote: false`
  // reaches here). Either way the only way through is a human-applied override.
  // An explicit label beats a project default, so an override carries a stage
  // past its gate whether that gate is a number or a switch.
  const entry = record(ctx, project, issueNumber, stage, score, threshold, present);
  if (present) {
    log("loop", `${scope}: ${stage} scored ${score}% (bar: ${threshold ?? "auto-promotion disabled"}) — carried past the gate by an operator override`);
    return { action: "proceed" };
  }

  const reason = holdReason(stage, score, threshold);
  log("loop", `${scope}: ${reason} — holding for human review`);
  return { action: "hold", reason, entry };
}

/**
 * Record the entry and, in the same write, stamp or clear `heldOnConfidence` —
 * the two must not drift, so no caller gets to do one without the other.
 */
function record(
  ctx: LoopContext,
  project: ProjectConfig,
  issueNumber: number,
  stage: ConfidenceStage,
  score: number,
  threshold: number | null,
  overridden: boolean,
): ConfidenceEntry {
  const held = threshold !== null && score >= threshold ? false : !overridden;
  const entry = recordConfidence(ctx, project.name, issueNumber, stage, score, threshold, overridden);
  ctx.state.update(project.name, issueNumber, { heldOnConfidence: held ? entry : undefined });
  return entry;
}

/**
 * Report whether a single-use override was attached, removing it if so. The
 * removal happens *before* any caller acts on the `true`: proceeding with the
 * label still attached would make the override permanent for this ticket, so a
 * failed removal has to surface as a throw rather than a silent `true`.
 */
async function consumeOverride(project: ProjectConfig, issueNumber: number): Promise<boolean> {
  const issue = await getIssue(project, issueNumber);
  if (!issue?.labels.includes(CONFIDENCE_OVERRIDE_LABEL)) return false;
  await removeLabel(project, issueNumber, CONFIDENCE_OVERRIDE_LABEL);
  return true;
}

function holdReason(stage: ConfidenceStage, score: number, threshold: number | null): string {
  return threshold === null
    ? `${stage} auto-promotion is disabled for this project`
    : `${stage} confidence ${score}% is below the ${threshold}% threshold`;
}

/**
 * Prepended to the operator's own text when a confidence-held ticket resumes,
 * from the stamped `heldOnConfidence` entry.
 *
 * Without this the deadlock is unbreakable: the resumed SDK session remembers
 * *scoring* 65% but nothing tells it that the score is why it stopped, so it
 * re-does the same work and re-scores the same way. Mirrors `STALL_NUDGE` in
 * recovery.ts — a fixed preamble concatenated ahead of the operator's message,
 * never a replacement for it.
 */
export function confidenceHoldPreamble(entry: ConfidenceEntry, waived: boolean): string {
  // A reviewer stage is scored by a *different*, one-shot session. The session
  // being resumed here is the worker whose output was reviewed, so "your
  // machine-review confidence was 55%" would name a number it never produced
  // and cannot move — it would go chase the reviewer's doubt instead of the
  // operator's actual instruction.
  if (entry.stage === "machine-review" || entry.stage === "plan-review") {
    return [
      `This ticket was held because an automated review of your work reported only ${entry.score}% confidence in its own verdict, below the ${entry.threshold}% threshold — not because of anything you scored.`,
      "Follow the instruction below; there is no score of yours to re-argue.",
      "",
    ].join("\n");
  }
  // A null threshold means the stage was never gated on a number at all, so
  // there is no comparison to report — saying "below the null% threshold" would
  // read as a bug to the session and invite it to chase a score it can't move.
  const held =
    entry.threshold === null
      ? `This ticket was held because ${entry.stage} auto-promotion is disabled for this project; your ${entry.stage} confidence was ${entry.score}%.`
      : `This ticket was held because your ${entry.stage} confidence was ${entry.score}%, below the ${entry.threshold}% threshold.`;
  if (waived) {
    return [
      held,
      "A human has reviewed the result and waived that gate for this attempt.",
      "Do not re-litigate the score or hedge into another low one: finish the work and report honestly.",
      "",
    ].join("\n");
  }
  return [
    held,
    "Address the specific uncertainty behind that score — verify the part you were unsure of — rather than restating work you already did.",
    "If you genuinely cannot raise your confidence, finish with status \"blocked\" and ask one specific question.",
    "",
  ].join("\n");
}
