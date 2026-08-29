import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  listNonFleetIssues: vi.fn(),
  getIssue: vi.fn(),
  addLabel: vi.fn(),
}));

const github = await import("../github/github.ts");

const enabled = makeProject({ name: "alpha", triage: true });
const disabled = makeProject({ name: "beta", triage: false });

function makeApp(projects = [enabled, disabled]) {
  const { dataDir, state } = makeTempState("fleet-server-triage-");
  const config = makeFleetConfig({ dataDir, projects });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

// Every mock is (re)armed per test rather than at module scope, so no
// test's override can leak into the next one.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(github.listNonFleetIssues).mockResolvedValue([
    {
      number: 4,
      title: "plain bug",
      body: "b",
      labels: ["bug"],
      url: "u4",
      author: "isaacalger",
      assignees: [],
    },
  ]);
  vi.mocked(github.getIssue).mockResolvedValue({ number: 4, title: "plain bug", body: "b", labels: ["bug"] });
  vi.mocked(github.addLabel).mockResolvedValue(undefined);
});

interface TriageListing {
  projects: { project: string; issues: { number: number; title: string }[]; error?: string }[];
}

describe("GET /api/triage", () => {
  it("lists non-fleet issues for triage-enabled projects only", async () => {
    const res = await makeApp().request("/api/triage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TriageListing;
    expect(body.projects.map((p) => p.project)).toEqual(["alpha"]);
    expect(body.projects[0]?.issues.map((i) => i.number)).toEqual([4]);
    expect(body.projects[0]?.error).toBeUndefined();
    expect(github.listNonFleetIssues).toHaveBeenCalledTimes(1);
    expect(github.listNonFleetIssues).toHaveBeenCalledWith(enabled);
  });

  it("keeps other projects rendering when one project's gh call fails", async () => {
    const second = makeProject({ name: "gamma", triage: true });
    vi.mocked(github.listNonFleetIssues).mockImplementation(async (project) => {
      if (project.name === "alpha") throw new Error("gh: boom");
      return [];
    });
    const res = await makeApp([enabled, second]).request("/api/triage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TriageListing;
    const alpha = body.projects.find((p) => p.project === "alpha");
    expect(alpha?.issues).toEqual([]);
    expect(alpha?.error).toBeTruthy();
    const gamma = body.projects.find((p) => p.project === "gamma");
    expect(gamma?.error).toBeUndefined();
    expect(gamma?.issues).toEqual([]);
  });
});

describe("POST /api/triage/:project/:issue/investigate", () => {
  it("labels the issue fleet:triage", async () => {
    const res = await postJson(makeApp(), "/api/triage/alpha/4/investigate", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(github.addLabel).toHaveBeenCalledWith(enabled, 4, "fleet:triage");
  });

  it("409s when the issue already carries a fleet:* label", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({ number: 4, title: "t", body: "b", labels: ["fleet:ready"] });
    const res = await postJson(makeApp(), "/api/triage/alpha/4/investigate", {});
    expect(res.status).toBe(409);
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("400s when triage is disabled for the project", async () => {
    const res = await postJson(makeApp(), "/api/triage/beta/4/investigate", {});
    expect(res.status).toBe(400);
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it("404s on an unknown project", async () => {
    const res = await postJson(makeApp(), "/api/triage/nope/4/investigate", {});
    expect(res.status).toBe(404);
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("404s when the issue cannot be fetched", async () => {
    vi.mocked(github.getIssue).mockResolvedValue(undefined);
    const res = await postJson(makeApp(), "/api/triage/alpha/4/investigate", {});
    expect(res.status).toBe(404);
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric issue param", async () => {
    const res = await postJson(makeApp(), "/api/triage/alpha/abc/investigate", {});
    expect(res.status).toBe(400);
    expect(github.addLabel).not.toHaveBeenCalled();
  });
});
