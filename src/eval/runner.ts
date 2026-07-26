import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../core.js";
import { initializeRepository } from "../repository.js";
import type { EvalDataset } from "./dataset.js";

export interface EvalQueryResult {
  query: string;
  expected: string[];
  found: string[];
  missing: string[];
  recallAtK: number;
  reciprocalRank: number;
  latencyMs: number;
  results: Array<{ rank: number; id: string; title: string; status: string; relevant: boolean }>;
}

export interface EvalReport {
  dataset: string;
  limit: number;
  seededMemories: number;
  summary: {
    queries: number;
    meanRecallAtK: number;
    mrr: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    missedQueries: Array<{ query: string; missing: string[] }>;
  };
  queries: EvalQueryResult[];
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function runEvaluation(core: RepositoryMemoryCore, dataset: EvalDataset, limit: number): EvalReport {
  for (const memory of dataset.memories) {
    core.record({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      ...(memory.confidence !== undefined ? { confidence: memory.confidence } : {}),
      ...(memory.scopeType ? { scopeType: memory.scopeType } : {}),
      ...(memory.scopeValue ? { scopeValue: memory.scopeValue } : {}),
      ...(memory.tags ? { tags: memory.tags } : {}),
      ...(memory.relatedFiles ? { relatedFiles: memory.relatedFiles } : {}),
    });
  }

  const queries: EvalQueryResult[] = dataset.queries.map((query) => {
    const start = performance.now();
    const results = core.search(query.query, { limit, ...(query.types ? { types: query.types } : {}) });
    const latencyMs = performance.now() - start;
    const expected = new Set(query.expect);
    const found = results.filter((result) => expected.has(result.title)).map((result) => result.title);
    const firstRelevant = results.findIndex((result) => expected.has(result.title));
    return {
      query: query.query,
      expected: query.expect,
      found,
      missing: query.expect.filter((title) => !found.includes(title)),
      recallAtK: round(found.length / query.expect.length),
      reciprocalRank: firstRelevant === -1 ? 0 : round(1 / (firstRelevant + 1)),
      latencyMs: round(latencyMs),
      results: results.map((result, index) => ({
        rank: index + 1,
        id: result.id,
        title: result.title,
        status: result.status,
        relevant: expected.has(result.title),
      })),
    };
  });

  const latencies = queries.map((query) => query.latencyMs).sort((a, b) => a - b);
  return {
    dataset: dataset.name,
    limit,
    seededMemories: dataset.memories.length,
    summary: {
      queries: queries.length,
      meanRecallAtK: round(queries.reduce((sum, query) => sum + query.recallAtK, 0) / queries.length),
      mrr: round(queries.reduce((sum, query) => sum + query.reciprocalRank, 0) / queries.length),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      missedQueries: queries.filter((query) => query.missing.length).map((query) => ({ query: query.query, missing: query.missing })),
    },
    queries,
  };
}

/**
 * Runs the evaluation in a throwaway Git repository and data directory so
 * results are reproducible and never touch existing repository memories.
 */
export function evaluateDataset(dataset: EvalDataset, limit: number): EvalReport {
  const repository = mkdtempSync(join(tmpdir(), "repomind-eval-repo-"));
  const data = mkdtempSync(join(tmpdir(), "repomind-eval-data-"));
  const previousDataDir = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = data;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repository, windowsHide: true });
    initializeRepository(repository).database.close();
    const core = new RepositoryMemoryCore(repository);
    try {
      return runEvaluation(core, dataset, limit);
    } finally {
      core.close();
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previousDataDir;
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}
