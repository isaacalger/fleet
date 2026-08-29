import { describe, expect, it } from "vitest";
import { ALL_FLEET_LABELS, TRIAGE_LABEL, boardStatusFromLabels } from "./labels.ts";

describe("TRIAGE_LABEL", () => {
  it("is fleet:triage", () => {
    expect(TRIAGE_LABEL).toBe("fleet:triage");
  });

  it("is included in ALL_FLEET_LABELS so init-labels creates it", () => {
    expect(ALL_FLEET_LABELS.map((l) => l.name)).toContain("fleet:triage");
  });

  it("maps to ready — a triage issue is awaiting pickup and belongs on the board", () => {
    expect(boardStatusFromLabels(["fleet:triage"])).toBe("ready");
    expect(boardStatusFromLabels(["bug", "fleet:triage"])).toBe("ready");
  });

  it("does not shadow a more specific state mid-claim", () => {
    expect(boardStatusFromLabels(["fleet:triage", "fleet:in-progress"])).toBe("in-progress");
    expect(boardStatusFromLabels(["fleet:triage", "fleet:needs-input"])).toBe("needs-input");
    expect(boardStatusFromLabels(["fleet:triage", "fleet:review"])).toBe("review");
  });
});
