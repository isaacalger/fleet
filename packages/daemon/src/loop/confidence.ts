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

  if (threshold !== null && score >= threshold) {
    recordConfidence(ctx, project.name, issueNumber, stage, score, threshold);
    return { action: "proceed" };
  }

  // Below the bar — or, for a null threshold, with no bar the score could ever
  // clear ("recorded, not gated": only triage with `triageAutoPromote: false`
  // reaches here). Either way the only way through is a human-applied override,
  // consumed here. An explicit label beats a project default, so an override
  // carries a stage past its gate whether that gate is a number or a switch.
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
    log("loop", `${scope}: ${stage} scored ${score}% (bar: ${threshold ?? "auto-promotion disabled"}) — carried past the gate by an operator override`);
    return { action: "proceed" };
  }

  const reason =
    threshold === null
      ? `${stage} auto-promotion is disabled for this project`
      : `${stage} confidence ${score}% is below the ${threshold}% threshold`;
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
