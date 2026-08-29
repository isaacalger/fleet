import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TriagePanel from "./TriagePanel.vue";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface TriageIssueFixture {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  assignees: string[];
  url: string;
}

function issue(overrides: Partial<TriageIssueFixture> = {}): TriageIssueFixture {
  return {
    number: 4,
    title: "plain bug",
    body: "b",
    labels: ["bug"],
    author: "isaacalger",
    assignees: [],
    url: "https://github.com/o/r/issues/4",
    ...overrides,
  };
}

type TriageGroup = { project: string; issues: TriageIssueFixture[]; error?: string };

/**
 * Stubs both endpoints the panel talks to. `groups` is a queue: each GET
 * /api/triage takes the next entry (the last one repeats), so a test can assert
 * on the refetch after an investigate. `post` decides the investigate response.
 */
function stubFetch(groups: TriageGroup[][], post: { ok?: boolean; status?: number; error?: string } = {}) {
  let getCount = 0;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const ok = post.ok ?? true;
      const status = post.status ?? (ok ? 200 : 502);
      return Promise.resolve({
        ok,
        status,
        url,
        json: () => Promise.resolve(ok ? { ok: true, queued: true } : { error: post.error }),
      } as Response);
    }
    const snapshot = groups[Math.min(getCount, groups.length - 1)]!;
    getCount += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      url,
      json: () => Promise.resolve({ projects: snapshot }),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  // The panel opens the board socket to refetch on `board-updated`; a no-op
  // stand-in keeps the tests off the network (and off its reconnect timers).
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  return { fetchMock, getCount: () => getCount };
}

async function mountPanel() {
  const wrapper = mount(TriagePanel);
  await flushPromises();
  return wrapper;
}

describe("TriagePanel", () => {
  it("renders one row per issue with its number, title and existing labels", async () => {
    stubFetch([[{ project: "alpha", issues: [issue(), issue({ number: 9, title: "second", labels: ["docs"] })] }]]);
    const wrapper = await mountPanel();

    const rows = wrapper.findAll("[data-testid='triage-issue']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("#4");
    expect(rows[0]!.text()).toContain("plain bug");
    expect(rows[0]!.text()).toContain("bug");
    expect(rows[0]!.text()).toContain("isaacalger");
    expect(rows[0]!.find("a").attributes("href")).toBe("https://github.com/o/r/issues/4");
    expect(rows[0]!.find("a").attributes("target")).toBe("_blank");
    expect(rows[1]!.text()).toContain("#9");
    expect(rows[1]!.text()).toContain("docs");
  });

  it("groups rows under a per-project heading", async () => {
    stubFetch([
      [
        { project: "alpha", issues: [issue()] },
        { project: "beta", issues: [issue({ number: 12, title: "beta thing" })] },
      ],
    ]);
    const wrapper = await mountPanel();

    const sections = wrapper.findAll("[data-testid='triage-project']");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.text()).toContain("alpha");
    expect(sections[0]!.text()).toContain("plain bug");
    expect(sections[1]!.text()).toContain("beta");
    expect(sections[1]!.text()).toContain("beta thing");
  });

  it("omits a project heading when it has neither issues nor an error", async () => {
    stubFetch([
      [
        { project: "alpha", issues: [issue()] },
        { project: "beta", issues: [] },
      ],
    ]);
    const wrapper = await mountPanel();

    expect(wrapper.findAll("[data-testid='triage-project']")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("beta");
  });

  it("POSTs to the investigate endpoint for the clicked project and issue", async () => {
    const { fetchMock } = stubFetch([[{ project: "alpha", issues: [issue({ number: 7 })] }]]);
    const wrapper = await mountPanel();

    await wrapper.find("[data-testid='triage-investigate']").trigger("click");
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/triage/alpha/7/investigate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows the queued state and refetches after a successful investigate", async () => {
    const { getCount } = stubFetch([[{ project: "alpha", issues: [issue()] }]]);
    const wrapper = await mountPanel();
    expect(getCount()).toBe(1);

    await wrapper.find("[data-testid='triage-investigate']").trigger("click");
    await flushPromises();

    const button = wrapper.find("[data-testid='triage-investigate']");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toContain("Queued");
    expect(getCount()).toBe(2);
  });

  it("surfaces a failed investigate inline and leaves the button enabled", async () => {
    stubFetch([[{ project: "alpha", issues: [issue()] }]], { ok: false, status: 502, error: "gh: boom" });
    const wrapper = await mountPanel();

    await wrapper.find("[data-testid='triage-investigate']").trigger("click");
    await flushPromises();

    const row = wrapper.find("[data-testid='triage-issue']");
    expect(row.text()).toContain("gh: boom");
    expect(wrapper.find("[data-testid='triage-investigate']").attributes("disabled")).toBeUndefined();
  });

  it("translates a 409 into human-readable wording", async () => {
    stubFetch([[{ project: "alpha", issues: [issue()] }]], {
      ok: false,
      status: 409,
      error: "alpha#4 already carries a fleet:* label",
    });
    const wrapper = await mountPanel();

    await wrapper.find("[data-testid='triage-investigate']").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Already in the fleet pipeline.");
    expect(wrapper.text()).not.toContain("fleet:* label");
  });

  it("renders a project-level error inline instead of an empty list", async () => {
    stubFetch([[{ project: "gamma", issues: [], error: "gh: boom" }]]);
    const wrapper = await mountPanel();

    expect(wrapper.findAll("[data-testid='triage-project']")).toHaveLength(1);
    expect(wrapper.text()).toContain("gamma");
    expect(wrapper.text()).toContain("gh: boom");
    expect(wrapper.findAll("[data-testid='triage-issue']")).toHaveLength(0);
  });

  it("renders nothing at all when every project is empty and error-free", async () => {
    stubFetch([
      [
        { project: "alpha", issues: [] },
        { project: "beta", issues: [] },
      ],
    ]);
    const wrapper = await mountPanel();

    // Only Vue's v-if placeholder comment survives — no heading, no empty-state box.
    expect(wrapper.text()).toBe("");
    expect(wrapper.findAll("*")).toHaveLength(0);
  });
});
