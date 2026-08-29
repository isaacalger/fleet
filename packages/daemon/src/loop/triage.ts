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
