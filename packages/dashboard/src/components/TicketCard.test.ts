import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BoardTicket, ClosedTicketRecord, ConfidenceEntry, TicketRecord } from "@fleet/shared";
import TicketCard from "./TicketCard.vue";

function ticket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    project: "alpha",
    issueNumber: 7,
    title: "login crashes on submit",
    url: "https://github.com/acme/alpha/issues/7",
    status: "ready",
    priority: null,
    type: null,
    isPlan: false,
    isTriage: false,
    ...overrides,
  };
}

function badgeTexts(ticketProp: BoardTicket): string[] {
  const wrapper = mount(TicketCard, { props: { ticket: ticketProp, selected: false } });
  return wrapper.findAll("[data-slot='badge']").map((b) => b.text());
}

function confidence(overrides: Partial<ConfidenceEntry> = {}): ConfidenceEntry {
  return { stage: "code", score: 91, threshold: 70, at: "2026-01-01T00:00:00.000Z", ...overrides };
}

/** The card only reads `record.confidenceHistory`, so a partial stands in for the full record. */
function record(history: ConfidenceEntry[]): TicketRecord {
  return { confidenceHistory: history } as TicketRecord;
}

describe("TicketCard confidence badge", () => {
  it("shows the latest recorded score", () => {
    const texts = badgeTexts(
      ticket({ record: record([confidence({ stage: "code", score: 91 }), confidence({ stage: "machine-review", score: 74 })]) }),
    );

    expect(texts).toContain("74%");
    expect(texts).not.toContain("91%");
  });

  it("renders no confidence badge for a ticket with no history", () => {
    const before = badgeTexts(ticket()).length;
    const after = badgeTexts(ticket({ record: record([confidence()]) })).length;

    expect(after).toBe(before + 1);
    expect(badgeTexts(ticket())).not.toContain("91%");
  });

  it("renders no confidence badge for a record with an empty history", () => {
    expect(badgeTexts(ticket({ record: record([]) })).length).toBe(badgeTexts(ticket()).length);
  });

  it("shows the final score on a Done-column ticket built from a closed record", () => {
    const closed = {
      confidenceHistory: [confidence({ stage: "machine-review", score: 88 })],
      prState: "MERGED",
      closedAt: "2026-01-02T00:00:00.000Z",
    } as ClosedTicketRecord;

    expect(badgeTexts(ticket({ status: "done", record: closed }))).toContain("88%");
  });
});

describe("TicketCard badges", () => {
  it("renders a triage badge when isTriage is true", () => {
    expect(badgeTexts(ticket({ isTriage: true }))).toContain("triage");
  });

  it("renders no triage badge when isTriage is false", () => {
    expect(badgeTexts(ticket())).not.toContain("triage");
  });

  it("styles the triage badge with the warning variant, distinct from plan's highlight", () => {
    const wrapper = mount(TicketCard, { props: { ticket: ticket({ isTriage: true }), selected: false } });
    const triageBadge = wrapper.findAll("[data-slot='badge']").find((b) => b.text() === "triage");
    expect(triageBadge?.classes()).toContain("text-warning");
    expect(triageBadge?.classes()).not.toContain("text-highlight");
  });

  it("still renders the plan badge unchanged, and only that one, for a plan ticket", () => {
    const texts = badgeTexts(ticket({ isPlan: true }));
    expect(texts).toContain("plan");
    expect(texts).not.toContain("triage");
  });
});
