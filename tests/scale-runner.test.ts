import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("10,000-L1 scale acceptance runner", () => {
  it("executes the complete flow in explicitly non-formal smoke mode", { timeout: 60_000 }, () => {
    const parent = mkdtempSync(join(tmpdir(), "repomind-scale-smoke-"));
    const workspace = join(parent, "workspace");
    try {
      execFileSync(process.execPath, [
        resolve("benchmarks/scalability/run-10k.mjs"),
        "--repo", resolve("."),
        "--workspace", workspace,
        "--commit", "HEAD",
        "--smoke",
        "--count", "100",
        "--repeat", "20",
      ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      const report = JSON.parse(readFileSync(join(workspace, "scale-10k-report.json"), "utf8"));
      expect(report).toMatchObject({
        kind: "repomind-scale-runner-smoke",
        integrity: { passed: true },
        configuration: { mode: "smoke", formalScaleTargetEvaluated: false, memories: 100, targets: null },
        dataset: {
          finalCounts: {
            memories: 100,
            evidenceBackedMemories: 100,
            ftsRows: 100,
            embeddings: 100,
          },
        },
      });
      expect(report.integrity.checks).toHaveLength(13);
      expect(report.integrity.checks.some((check: { name: string }) => check.name.includes("P95"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
