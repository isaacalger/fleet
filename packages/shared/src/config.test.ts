import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./index.ts";

describe("triage config", () => {
  it("defaults triage off and the threshold to 80", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p", repoPath: "/tmp/p", githubRepo: "o/p",
    });
    expect(parsed.triage).toBe(false);
    expect(parsed.triageAutoPromoteThreshold).toBe(80);
  });

  it("accepts 101 as the never-auto-promote sentinel", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p", repoPath: "/tmp/p", githubRepo: "o/p", triageAutoPromoteThreshold: 101,
    });
    expect(parsed.triageAutoPromoteThreshold).toBe(101);
  });

  it("rejects a threshold above 101 or below 0", () => {
    const base = { name: "p", repoPath: "/tmp/p", githubRepo: "o/p" };
    expect(ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: 102 }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: -1 }).success).toBe(false);
  });
});
