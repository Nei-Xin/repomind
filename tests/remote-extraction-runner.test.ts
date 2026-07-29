import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v0.16 remote extraction acceptance runner", () => {
  it("rebuilds the complete acceptance flow with deterministic model fixtures", { timeout: 60_000 }, () => {
    const parent = mkdtempSync(join(tmpdir(), "repomind-remote-extraction-acceptance-"));
    const workspace = join(parent, "workspace");
    try {
      execFileSync(process.execPath, [
        resolve("benchmarks/remote-extraction/run-acceptance.mjs"),
        "--repo", resolve("."),
        "--workspace", workspace,
        "--commit", "HEAD",
        "--mock",
      ], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, REPOMIND_EXTRACTION_API_KEY: "acceptance-test-secret-must-not-leak" },
      });

      const reportText = readFileSync(join(workspace, "v0.16-remote-extraction-report.json"), "utf8");
      expect(reportText).not.toContain("acceptance-test-secret-must-not-leak");
      const report = JSON.parse(reportText);
      expect(report).toMatchObject({
        kind: "repomind-v0.16-remote-extraction-acceptance",
        mode: "mock",
        integrity: { passed: true },
        dataset: { scenarios: 9 },
        metrics: {
          scenarioRecall: 1,
          candidatePrecision: 1,
          emptyAccuracy: 1,
          evidenceBindingRate: 1,
          auditBindingRate: 1,
        },
      });
      expect(report.integrity.checks).toHaveLength(13);
      expect(report.failureProbes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "malformed", rejected: true, zeroWrites: true }),
        expect.objectContaining({ kind: "fabricated-evidence", rejected: true, zeroWrites: true }),
        expect.objectContaining({ kind: "cancel", rejected: true, zeroWrites: true }),
      ]));
      expect(readFileSync(join(workspace, "v0.16-remote-extraction-report.md"), "utf8")).toContain("Integrity: **passed**");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
