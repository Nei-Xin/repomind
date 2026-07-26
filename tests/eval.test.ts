import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/eval/dataset.js";
import { evaluateDataset } from "../src/eval/runner.js";

describe("retrieval evaluation", () => {
  it("achieves full recall on a trivially matching dataset", () => {
    const report = evaluateDataset({
      name: "inline",
      memories: [
        { type: "command", title: "Run tests", content: "npm test runs the suite." },
        { type: "decision", title: "Storage decision", content: "SQLite stores all local data." },
      ],
      queries: [
        { query: "npm test suite", expect: ["Run tests"] },
        { query: "SQLite local data", expect: ["Storage decision"] },
      ],
    }, 5);
    expect(report.summary).toMatchObject({ queries: 2, meanRecallAtK: 1, mrr: 1 });
    expect(report.summary.missedQueries).toEqual([]);
    expect(report.queries[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports misses honestly instead of padding results", () => {
    const report = evaluateDataset({
      name: "miss",
      memories: [
        { type: "convention", title: "Unrelated rule", content: "Completely unrelated content." },
      ],
      queries: [
        { query: "zzqx nonexistent phrase", expect: ["Unrelated rule"] },
      ],
    }, 5);
    expect(report.summary.meanRecallAtK).toBe(0);
    expect(report.summary.missedQueries).toEqual([{ query: "zzqx nonexistent phrase", missing: ["Unrelated rule"] }]);
  });

  it("runs the shipped basic-retrieval dataset with high recall", () => {
    const dataset = loadDataset("benchmarks/datasets/basic-retrieval.json");
    const report = evaluateDataset(dataset, 5);
    expect(report.seededMemories).toBe(10);
    expect(report.summary.meanRecallAtK).toBe(1);
    expect(report.summary.mrr).toBeGreaterThanOrEqual(0.9);
    expect(report.summary.missedQueries).toEqual([]);
  });
});
