import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIDENCE_OVERRIDE_LABEL } from "@fleet/shared";
import { makeCtx, makeProject, makeRecord } from "../test-support.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getIssue: vi.fn(async () => undefined),
  removeLabel: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");
const { confidenceGate, confidenceHoldPreamble, recordConfidence, thresholdFor } = await import("./confidence.ts");

/** A ctx with the ticket the gate scores already in the store — `update` is a no-op without it. */
function ctxWithTicket() {
  const ctx = makeCtx();
  ctx.state.upsert(makeRecord());
  return ctx;
}

const trail = (ctx: ReturnType<typeof makeCtx>) =>
  (ctx.state.get("alpha", 62)?.confidenceHistory ?? []).map((e) => [e.stage, e.score]);

/** The issue shape `getIssue` returns, carrying whatever labels the test needs. */
const issueWith = (labels: string[]) => ({ number: 62, title: "issue 62", body: "", labels });

beforeEach(() => {
  vi.mocked(github.getIssue).mockReset().mockResolvedValue(undefined);
  vi.mocked(github.removeLabel).mockReset().mockResolvedValue(undefined);
});

describe("thresholdFor", () => {
  it("ungates triage only when triageAutoPromote is off", () => {
    expect(thresholdFor(makeProject({ triageAutoPromote: false }), "triage")).toBeNull();
    expect(thresholdFor(makeProject({ triageAutoPromote: false }), "code")).toBe(70);
    expect(thresholdFor(makeProject(), "triage")).toBe(70);
  });
});

describe("recordConfidence", () => {
  it("appends without replacing, preserving order", () => {
    const ctx = ctxWithTicket();

    recordConfidence(ctx, "alpha", 62, "triage", 88, 70);
    recordConfidence(ctx, "alpha", 62, "code", 91, 70);

    expect(trail(ctx)).toEqual([["triage", 88], ["code", 91]]);
  });

  it("logs rather than silently dropping a score for a ticket no longer in the store", () => {
    const ctx = makeCtx();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    recordConfidence(ctx, "alpha", 62, "code", 44, 70);

    expect(ctx.state.get("alpha", 62)).toBeUndefined();
    expect(errors.mock.calls.flat().join(" ")).toContain("confidence entry dropped (code 44%)");
    errors.mockRestore();
  });
});

describe("confidenceGate", () => {
  it("proceeds at exactly the threshold", async () => {
    const ctx = ctxWithTicket();

    const result = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 62, "code", 70);

    expect(result.action).toBe("proceed");
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it("holds below the threshold and still records the score against the real threshold", async () => {
    const ctx = ctxWithTicket();

    const result = await confidenceGate(ctx, makeProject({ confidenceThreshold: 70 }), 62, "code", 69);

    expect(result.action).toBe("hold");
    expect(ctx.state.get("alpha", 62)?.confidenceHistory).toEqual([
      expect.objectContaining({ stage: "code", score: 69, threshold: 70 }),
    ]);
  });

  it("holds when the stage is ungated — a null threshold is unpassable, not absent — and stamps it", async () => {
    const ctx = ctxWithTicket();

    const result = await confidenceGate(ctx, makeProject({ triageAutoPromote: false }), 62, "triage", 100);

    expect(result.action).toBe("hold");
    if (result.action === "hold") expect(result.reason).toContain("auto-promotion is disabled");
    expect(ctx.state.get("alpha", 62)?.confidenceHistory).toEqual([
      expect.objectContaining({ score: 100, threshold: null }),
    ]);
  });

  it("lets an operator override beat a project default that disabled auto-promotion", async () => {
    const ctx = ctxWithTicket();
    vi.mocked(github.getIssue).mockResolvedValue(issueWith([CONFIDENCE_OVERRIDE_LABEL]));

    const result = await confidenceGate(ctx, makeProject({ triageAutoPromote: false }), 62, "triage", 3);

    expect(result.action).toBe("proceed");
    expect(github.removeLabel).toHaveBeenCalledWith(expect.anything(), 62, CONFIDENCE_OVERRIDE_LABEL);
  });

  it("carries a low score past the gate on an operator override, consuming the label", async () => {
    const ctx = ctxWithTicket();
    vi.mocked(github.getIssue).mockResolvedValue(issueWith([CONFIDENCE_OVERRIDE_LABEL]));

    const result = await confidenceGate(ctx, makeProject(), 62, "code", 10);

    expect(result.action).toBe("proceed");
    expect(github.removeLabel).toHaveBeenCalledWith(makeProject(), 62, CONFIDENCE_OVERRIDE_LABEL);
    expect(ctx.state.get("alpha", 62)?.confidenceHistory).toEqual([
      expect.objectContaining({ score: 10, overridden: true }),
    ]);
  });

  it("holds when the override label cannot be removed, rather than making it permanent", async () => {
    const ctx = ctxWithTicket();
    vi.mocked(github.getIssue).mockResolvedValue(issueWith([CONFIDENCE_OVERRIDE_LABEL]));
    vi.mocked(github.removeLabel).mockRejectedValueOnce(new Error("gh exploded"));

    const result = await confidenceGate(ctx, makeProject(), 62, "code", 10);

    expect(result.action).toBe("hold");
    expect(ctx.state.get("alpha", 62)?.confidenceHistory?.[0]).not.toHaveProperty("overridden");
  });

  it("does not reuse one override for a second gate on the same ticket", async () => {
    const ctx = ctxWithTicket();
    // Stateful, so the second gate only sees the label gone because the first
    // gate actually removed it — not because the test queued it that way.
    const labels = new Set([CONFIDENCE_OVERRIDE_LABEL]);
    vi.mocked(github.getIssue).mockImplementation(async () => issueWith([...labels]));
    vi.mocked(github.removeLabel).mockImplementation(async (_p, _n, label) => void labels.delete(label));

    const first = await confidenceGate(ctx, makeProject(), 62, "code", 10);
    const second = await confidenceGate(ctx, makeProject(), 62, "machine-review", 10);

    expect([first.action, second.action]).toEqual(["proceed", "hold"]);
    expect(github.removeLabel).toHaveBeenCalledTimes(1);
  });

  it("holds when the issue cannot be read, so a gh outage cannot leak a low score through", async () => {
    const ctx = ctxWithTicket();
    vi.mocked(github.getIssue).mockRejectedValueOnce(new Error("gh down"));

    const result = await confidenceGate(ctx, makeProject(), 62, "code", 10);

    expect(result.action).toBe("hold");
    expect(github.removeLabel).not.toHaveBeenCalled();
  });
});

describe("confidenceHoldPreamble", () => {
  const entry = { stage: "code" as const, score: 42, threshold: 70, at: "2026-01-01T00:00:00.000Z" };

  it("names the score and the threshold it missed", () => {
    expect(confidenceHoldPreamble(entry, false)).toContain("42%");
    expect(confidenceHoldPreamble(entry, false)).toContain("70%");
  });

  it("never renders a null threshold as a percentage", () => {
    const ungated = { ...entry, stage: "triage" as const, threshold: null };

    expect(confidenceHoldPreamble(ungated, false)).not.toContain("null");
    expect(confidenceHoldPreamble(ungated, false)).toContain("auto-promotion is disabled");
  });

  it("reads as waived once a human has reviewed the result", () => {
    expect(confidenceHoldPreamble(entry, true)).toContain("waived");
    expect(confidenceHoldPreamble(entry, false)).not.toContain("waived");
  });
});
