import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./index.ts";

const base = { name: "p", repoPath: "/tmp/p", githubRepo: "o/p" };

describe("triage config", () => {
  it("defaults triage off", () => {
    expect(ProjectConfigSchema.parse(base).triage).toBe(false);
  });
});

describe("confidence config", () => {
  it("defaults confidenceThreshold to 70 and triageAutoPromote to true", () => {
    const parsed = ProjectConfigSchema.parse(base);
    expect(parsed.confidenceThreshold).toBe(70);
    expect(parsed.triageAutoPromote).toBe(true);
  });

  it("rejects a threshold above 100 or below 0", () => {
    expect(ProjectConfigSchema.safeParse({ ...base, confidenceThreshold: 101 }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...base, confidenceThreshold: -1 }).success).toBe(false);
  });

  it("rejects a config still carrying the removed triageAutoPromoteThreshold", () => {
    const result = ProjectConfigSchema.safeParse({ ...base, triageAutoPromoteThreshold: 101 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("confidenceThreshold");
  });
});
