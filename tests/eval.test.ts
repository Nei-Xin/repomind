import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("never reports recall above 1 when several results share an expected title", () => {
    const report = evaluateDataset({
      name: "duplicate-titles",
      memories: [
        { type: "command", title: "Build command", content: "Run npm run build to compile." },
        { type: "command", title: "Build command", content: "Run npm run build with the watch flag." },
      ],
      queries: [
        { query: "npm run build", expect: ["Build command"] },
      ],
    }, 5);
    expect(report.queries[0]!.recallAtK).toBe(1);
    expect(report.summary.meanRecallAtK).toBe(1);
  });

  it("rejects datasets whose seeded memories share a title", () => {
    const path = join(tmpdir(), `repomind-eval-dataset-${process.pid}.json`);
    writeFileSync(path, JSON.stringify({
      name: "ambiguous",
      memories: [
        { type: "command", title: "Build command", content: "One." },
        { type: "command", title: "Build command", content: "Two." },
      ],
      queries: [{ query: "build", expect: ["Build command"] }],
    }), "utf8");
    try {
      expect(() => loadDataset(path)).toThrow(/duplicate memory titles/);
    } finally {
      rmSync(path, { force: true });
    }
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
