import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("L4 Skill Candidate acceptance runner", () => {
  it("executes the complete rebuildable acceptance flow", { timeout: 60_000 }, () => {
    const parent = mkdtempSync(join(tmpdir(), "repomind-l4-acceptance-"));
    const workspace = join(parent, "workspace");
    try {
      execFileSync(process.execPath, [
        resolve("benchmarks/skill-candidates/run-acceptance.mjs"),
        "--repo", resolve("."),
        "--workspace", workspace,
        "--commit", "HEAD",
        "--repeat", "5",
      ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      const report = JSON.parse(readFileSync(join(workspace, "l4-skill-candidate-report.json"), "utf8"));
      expect(report).toMatchObject({
        kind: "repomind-l4-skill-candidate-acceptance",
        integrity: { passed: true },
        dataset: {
          successfulSessions: 4,
          excludedSessions: 4,
          candidateSources: 4,
          repetitions: 5,
        },
      });
      expect(report.integrity.checks).toHaveLength(20);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
