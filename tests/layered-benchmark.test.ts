import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface L2Manifest {
  schemaVersion: number;
  budgetChars: number;
  memories: Array<{ title: string; scopeType: string; scopeValue: string; confidence: number; relatedFiles: string[] }>;
  queries: string[];
}

describe("real-repository L2 benchmark assets", () => {
  it("keeps the reviewed manifest internally valid and bound to real repository files", () => {
    const manifest = JSON.parse(readFileSync(resolve("benchmarks/layered-memory/repomind-l2-manifest.json"), "utf8")) as L2Manifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.budgetChars).toBeGreaterThanOrEqual(500);
    expect(manifest.memories.length).toBeGreaterThanOrEqual(10);
    expect(new Set(manifest.memories.map((memory) => memory.title)).size).toBe(manifest.memories.length);
    expect(manifest.queries.length).toBeGreaterThanOrEqual(5);
    for (const memory of manifest.memories) {
      expect(memory).toMatchObject({ scopeType: "module", scopeValue: expect.stringMatching(/^src\//u) });
      expect(memory.confidence).toBeGreaterThanOrEqual(0.8);
      expect(memory.relatedFiles.length).toBeGreaterThan(0);
      expect(memory.relatedFiles.every((file) => existsSync(resolve(file)))).toBe(true);
    }
  });
});
