import { describe, expect, it } from "vitest";
import { runScenarioSuite } from "../src/eval/scenarios.js";

describe("cross-session scenario suite", () => {
  it("passes every scenario and meets the spec's deterministic targets", { timeout: 60_000 }, () => {
    const report = runScenarioSuite();
    const failures = report.scenarios.filter((scenario) => !scenario.passed);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(report.summary).toMatchObject({
      scenarios: 6,
      passed: 6,
      failed: 0,
      crossSessionRecall: 1,
      evidenceBindingRate: 1,
      isolationViolations: 0,
      staleWarnedRate: 1,
      conflictSurfacedRate: 1,
      idempotencyViolations: 0,
    });
  });
});
