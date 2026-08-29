import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConfidenceEntry } from "@fleet/shared";
import ConfidenceBadge from "./ConfidenceBadge.vue";

function entry(overrides: Partial<ConfidenceEntry> = {}): ConfidenceEntry {
  return {
    stage: "code",
    score: 91,
    threshold: 70,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function badge(e: ConfidenceEntry, showStage = false) {
  return mount(ConfidenceBadge, { props: { entry: e, showStage } });
}

describe("ConfidenceBadge", () => {
  it("renders the score as a percentage", () => {
    expect(badge(entry()).text()).toBe("91%");
  });

  it("passes at exactly the threshold", () => {
    const wrapper = badge(entry({ score: 70, threshold: 70 }));

    expect(wrapper.classes()).toContain("text-success");
    expect(wrapper.classes()).not.toContain("text-destructive");
  });

  it("fails just below the threshold", () => {
    const wrapper = badge(entry({ score: 69, threshold: 70 }));

    expect(wrapper.classes()).toContain("text-destructive");
  });

  it("renders muted, not failing, when the stage was never gated on a number", () => {
    const wrapper = badge(entry({ score: 12, threshold: null }));

    expect(wrapper.classes()).toContain("text-muted-foreground");
    expect(wrapper.classes()).not.toContain("text-destructive");
    expect(wrapper.attributes("title")).toContain("not gated");
  });

  it("renders an overridden sub-threshold score as a marked pass", () => {
    const wrapper = badge(entry({ score: 20, threshold: 70, overridden: true }));

    expect(wrapper.classes()).toContain("text-success");
    expect(wrapper.text()).toBe("20%*");
    expect(wrapper.attributes("title")).toContain("override");
  });

  it("distinguishes an overridden pass from an ordinary one", () => {
    expect(badge(entry({ score: 91, overridden: true })).text()).not.toBe(badge(entry({ score: 91 })).text());
  });

  it("prefixes the stage name only when showStage is set", () => {
    expect(badge(entry(), true).text()).toBe("Code 91%");
    expect(badge(entry({ stage: "machine-review" }), true).text()).toBe("Review 91%");
    expect(badge(entry({ stage: "plan-review" }), true).text()).toBe("Plan review 91%");
    expect(badge(entry({ stage: "triage" }), true).text()).toBe("Triage 91%");
    expect(badge(entry({ stage: "plan" }), true).text()).toBe("Plan 91%");
  });
});
