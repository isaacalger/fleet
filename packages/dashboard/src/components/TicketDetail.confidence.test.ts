import { flushPromises, mount } from "@vue/test-utils";
import type { BoardTicket, ConfidenceEntry, TicketDetail as TicketDetailType } from "@fleet/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import TicketDetail from "./TicketDetail.vue";

function makeTicket(): BoardTicket {
  return {
    project: "owner/repo",
    issueNumber: 7,
    title: "Some ticket",
    url: "https://github.com/owner/repo/issues/7",
    status: "review",
    priority: null,
    type: null,
    isPlan: false,
    isTriage: false,
  };
}

function confidence(overrides: Partial<ConfidenceEntry> = {}): ConfidenceEntry {
  return { stage: "code", score: 91, threshold: 70, at: "2026-01-01T00:00:00.000Z", ...overrides };
}

function stubFetch(detail: TicketDetailType) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const href = String(url);
      if (href.endsWith("/report")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          url: href,
          json: () =>
            Promise.resolve({
              toolCounts: {},
              toolErrorCounts: {},
              errorCount: 0,
              segments: [],
              totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
            }),
        } as Response);
      }
      if (href.endsWith("/diff") || href.endsWith("/transcript")) {
        return Promise.resolve({ ok: false, status: 404, url: href, json: () => Promise.resolve({ error: "none" }) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, url: href, json: () => Promise.resolve(detail) } as Response);
    }),
  );
}

async function mountWith(confidenceHistory?: ConfidenceEntry[]) {
  stubFetch({
    journal: [],
    canRestart: false,
    canReply: false,
    record: (confidenceHistory ? { confidenceHistory } : {}) as never,
  });
  const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountWith>>;

const allBadges = (wrapper: Wrapper) => wrapper.findAll("[data-slot='badge']").map((b) => b.text());
const scoreBadges = (wrapper: Wrapper) => allBadges(wrapper).filter((t) => t.endsWith("%"));
const toggle = (wrapper: Wrapper) => wrapper.find("[data-testid='confidence-trail-toggle']");

describe("TicketDetail confidence trail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows only the latest entry, with its stage, when collapsed", async () => {
    const wrapper = await mountWith([
      confidence({ stage: "triage", score: 55, threshold: 60 }),
      confidence({ stage: "code", score: 91 }),
    ]);

    expect(scoreBadges(wrapper)).toEqual(["Code 91%"]);
    expect(toggle(wrapper).text()).toContain("history");
  });

  it("lists the whole trail once expanded", async () => {
    const wrapper = await mountWith([
      confidence({ stage: "triage", score: 55, threshold: 60 }),
      confidence({ stage: "code", score: 91 }),
      confidence({ stage: "machine-review", score: 74 }),
    ]);

    await toggle(wrapper).trigger("click");

    expect(scoreBadges(wrapper)).toEqual(["Review 74%", "Triage 55%", "Code 91%", "Review 74%"]);
    expect(toggle(wrapper).text()).toContain("hide");
  });

  it("renders a partial trail with no placeholders for the stages it skipped", async () => {
    const wrapper = await mountWith([confidence({ stage: "code", score: 91 }), confidence({ stage: "machine-review", score: 74 })]);

    await toggle(wrapper).trigger("click");

    expect(scoreBadges(wrapper)).toEqual(["Review 74%", "Code 91%", "Review 74%"]);
  });

  it("renders no confidence badge at all for a ticket with no history", async () => {
    const withHistory = await mountWith([confidence()]);
    const without = await mountWith();

    expect(allBadges(without).length).toBe(allBadges(withHistory).length - 1);
    expect(scoreBadges(without)).toEqual([]);
    expect(toggle(without).exists()).toBe(false);
  });
});
