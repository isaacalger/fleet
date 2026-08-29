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
