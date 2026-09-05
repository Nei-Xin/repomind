import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDiff, filesChangedBetweenHeads } from "../src/git/git-inspector.js";
import { createTestRepository, git } from "./helpers.js";

describe("bounded Git diff capture", () => {
  let repository: string;
  let baseline: string;

  beforeEach(() => {
    repository = createTestRepository("repomind-diff-");
    baseline = git(repository, "rev-parse", "HEAD");
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  it.each(["working", "staged", "committed"])("retains and marks a %s diff exceeding 1 MiB", (source) => {
    writeFileSync(join(repository, "README.txt"), "large tracked change with enough text to exceed the Git output buffer\n".repeat(24_000));
    if (source !== "working") git(repository, "add", "README.txt");
    if (source === "committed") git(repository, "commit", "-m", "large change");
    const head = git(repository, "rev-parse", "HEAD");
    const diff = captureDiff(repository, baseline, head);
    expect(diff).toMatchObject({ truncated: true, sources: [source], excludedFiles: [] });
    expect(diff.content).toContain("large tracked change");
    expect(Buffer.byteLength(diff.content)).toBeLessThanOrEqual(65_536);
    // The process capture limit must remain visible even with a larger final content budget.
    if (source === "working") {
      const largerBudget = captureDiff(repository, baseline, head, 2 * 1024 * 1024);
      expect(largerBudget.truncated).toBe(true);
      expect(largerBudget.content).toContain("large tracked change");
      expect(Buffer.byteLength(largerBudget.content)).toBeLessThan(2 * 1024 * 1024);
    }
  });

  it("distinguishes empty, complete, and byte-limited diffs", () => {
    expect(captureDiff(repository, baseline, baseline)).toEqual({ content: "", truncated: false, sources: [], excludedFiles: [] });
    writeFileSync(join(repository, "README.txt"), "initial\n中文修改\n");
    const complete = captureDiff(repository, baseline, baseline);
    expect(complete).toMatchObject({ truncated: false, sources: ["working"] });
    expect(complete.content).toContain("中文修改");
    const limit = Buffer.byteLength(complete.content.slice(0, complete.content.indexOf("中文"))) + 1;
    const clipped = captureDiff(repository, baseline, baseline, limit);
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(clipped.content)).toBeLessThanOrEqual(limit);
    expect(clipped.content).not.toContain("\uFFFD");
  });

  it("reports Git execution failures instead of returning an empty diff", () => {
    for (const work of [
      () => captureDiff(repository, "missing-revision", baseline),
      () => captureDiff(join(repository, "missing-directory"), baseline, baseline),
      () => filesChangedBetweenHeads(repository, "missing-revision", baseline),
    ]) {
      expect(work).toThrowError(expect.objectContaining({ code: "GIT_INSPECTION_FAILED" }));
    }
  });
});
