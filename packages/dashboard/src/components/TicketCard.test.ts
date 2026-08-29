import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BoardTicket } from "@fleet/shared";
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
