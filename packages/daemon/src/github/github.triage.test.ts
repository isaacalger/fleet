import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";

vi.mock("./exec.ts", () => ({
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
  runJson: vi.fn(async () => ({})),
  runJsonPaginated: vi.fn(async () => []),
  runShell: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

const exec = await import("./exec.ts");
const { appendTriageSpecSafely, hashBody, createIssueComment } = await import("./github.ts");

const project = makeProject();
const SPEC = "## Problem\nBroken.\n\n## Acceptance criteria\n- Fixed\n\n## Verification\nnpm test";

beforeEach(() => vi.clearAllMocks());

describe("hashBody", () => {
  it("is stable and differs on any change", () => {
    expect(hashBody("abc")).toBe(hashBody("abc"));
    expect(hashBody("abc")).not.toBe(hashBody("abd"));
  });

  it("returns a 64-char hex sha256", () => {
    expect(hashBody("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createIssueComment", () => {
  it("posts a new comment rather than editing an existing one", async () => {
    await createIssueComment(project, 7, "hello");
    const args = vi.mocked(exec.run).mock.calls[0]![1];
    expect(args).toContain("comment");
    expect(args).not.toContain("PATCH");
  });
});

describe("appendTriageSpecSafely", () => {
  it("appends to the body when the hash is unchanged", async () => {
    const body = "Original body";
    vi.mocked(exec.runJson).mockResolvedValue({ number: 7, title: "t", body, labels: [] });

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody(body));

    expect(outcome).toBe("appended");
    const stdins = vi.mocked(exec.run).mock.calls.map((c) => c[2]?.stdin);
    expect(stdins.some((s) => s?.includes("Original body") && s?.includes("## Problem"))).toBe(true);
  });

  it("comments instead of editing when the body changed mid-run", async () => {
    vi.mocked(exec.runJson).mockResolvedValue({ number: 7, title: "t", body: "EDITED by a human", labels: [] });

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody("Original body"));

    expect(outcome).toBe("commented");
    const calls = vi.mocked(exec.run).mock.calls;
    expect(calls.some((c) => c[2]?.stdin?.includes("Concurrent edit detected"))).toBe(true);
    expect(calls.some((c) => c[2]?.stdin?.includes("## Problem"))).toBe(true);
  });

  it("does not touch the body when a collision is detected", async () => {
    vi.mocked(exec.runJson).mockResolvedValue({ number: 7, title: "t", body: "EDITED", labels: [] });
    await appendTriageSpecSafely(project, 7, SPEC, hashBody("Original body"));
    const calls = vi.mocked(exec.run).mock.calls;
    // no `gh issue edit` invocation at all
    expect(calls.some((c) => c[1].includes("edit"))).toBe(false);
  });

  it("fails closed when the issue cannot be fetched", async () => {
    vi.mocked(exec.runJson).mockRejectedValue(new Error("gh exploded"));

    const outcome = await appendTriageSpecSafely(project, 7, SPEC, hashBody("Original body"));

    expect(outcome).toBe("commented");
  });
});
