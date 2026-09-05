import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("L2 module narratives", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-l2-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("fills the requested limit past a full batch of stale narratives", () => {
    const core = new RepositoryMemoryCore(repository);
    try {
      for (let index = 0; index < 23; index++) {
        core.record({
          type: "architecture",
          title: "Paginationtoken boundary",
          content: "Paginationtoken owns the module boundary.",
          scopeType: "module",
          scopeValue: `src/module${String(index).padStart(2, "0")}`,
        });
      }
      core.rebuildModuleNarratives();
      const firstBatch = core.searchModuleNarratives("paginationtoken", 20);
      expect(firstBatch).toHaveLength(20);
      for (const narrative of firstBatch) {
        core.invalidateMemory({ memoryId: narrative.sourceMemoryIds[0]!, reason: "The module boundary changed." });
      }
      const staleIds = new Set(firstBatch.map((narrative) => narrative.id));
      const results = core.searchModuleNarratives("paginationtoken", 2);
      expect(results).toHaveLength(2);
      expect(results.every((narrative) => narrative.current && !staleIds.has(narrative.id))).toBe(true);
      const remaining = core.searchModuleNarratives("paginationtoken", 20);
      expect(remaining).toHaveLength(3);
      expect(new Set(remaining.map((narrative) => narrative.id)).size).toBe(3);
      expect(results).toEqual(remaining.slice(0, 2));
      expect(core.searchModuleNarratives("no_matching_narrative")).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("builds bounded L2 from active evidence-backed L1 and tracks incremental changes", () => {
    const core = new RepositoryMemoryCore(repository);
    const architecture = core.record({
      type: "architecture",
      title: "Storage boundary",
      content: "The storage module owns SQLite transactions and schema migrations.",
      scopeType: "module",
      scopeValue: "src/storage",
    });
    const command = core.record({
      type: "command",
      title: "Storage verification",
      content: "Run npm test -- storage before changing migrations.",
      relatedFiles: ["src/storage/database.ts"],
    });
    const conflicting = core.record({
      type: "decision", title: "Storage engine", content: "Use SQLite.", scopeType: "module", scopeValue: "src/storage",
    });
    const rejected = core.record({
      type: "decision", title: "Storage engine", content: "Use PostgreSQL.", scopeType: "module", scopeValue: "src/storage",
    });
    expect(core.inspect(conflicting.id).status).toBe("uncertain");
    expect(core.inspect(rejected.id).status).toBe("uncertain");

    const first = core.rebuildModuleNarratives({ maxChars: 700 });
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0, deleted: 0 });
    const narrative = first.narratives[0]!;
    expect(narrative).toMatchObject({
      modulePath: "src/storage",
      sourceCount: 2,
      sourceMemoryIds: [architecture.id, command.id],
      budgetChars: 700,
      version: 1,
      current: true,
    });
    expect(narrative.content.length).toBeLessThanOrEqual(700);
    expect(narrative.content).toContain(architecture.id);
    expect(narrative.content).toContain(command.id);
    expect(narrative.content.indexOf(architecture.id)).toBeLessThan(narrative.content.indexOf(command.id));
    expect(narrative.content).not.toContain(conflicting.id);
    expect(narrative.content.split("\n").filter((line) => line.startsWith("- ["))
      .every((line) => /\(mem_[^)]+\)$/u.test(line))).toBe(true);

    const details = core.inspectModuleNarrative(narrative.id);
    expect(details.sources).toHaveLength(2);
    expect(details.sources.every((source) => source.evidenceIds.length > 0)).toBe(true);
    expect(core.rebuildModuleNarratives({ maxChars: 700 })).toMatchObject({ unchanged: 1 });

    core.record({
      type: "risk",
      title: "Native extension risk",
      content: "sqlite-vec must match the Node runtime architecture.",
      scopeType: "module",
      scopeValue: "src/storage",
    });
    expect(core.listModuleNarratives()[0]).toMatchObject({ current: false, version: 1 });
    const updated = core.rebuildModuleNarratives({ modules: ["src/storage"], maxChars: 700 });
    expect(updated).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(updated.narratives[0]).toMatchObject({ current: true, version: 2, sourceCount: 3 });
    expect(core.status()).toMatchObject({
      moduleNarratives: 1,
      capabilities: { layeredMemory: { l0: true, l1: true, l2: true, l3: true, l4: true } },
    });

    core.context.database.raw.prepare("DELETE FROM module_narrative_fts WHERE repository_id=?")
      .run(core.context.marker.projectId);
    expect(core.searchModuleNarratives("storage transaction")).toEqual([]);
    expect(core.reindex()).toMatchObject({ moduleNarratives: 1 });

    const started = core.startSession({ task: "Change the storage module transaction boundary" });
    expect(started.moduleNarratives).toEqual([expect.objectContaining({ id: narrative.id, current: true })]);
    core.abandonSession(started.sessionId);
    core.close();
  });

  it("deletes a requested derived narrative when no valid L1 source remains", () => {
    const core = new RepositoryMemoryCore(repository);
    const source = core.record({
      type: "risk", title: "CLI risk", content: "Keep stdout protocol-clean.", scopeType: "module", scopeValue: "src/cli",
    });
    const narrative = core.rebuildModuleNarratives().narratives[0]!;
    core.invalidateMemory({ memoryId: source.id, reason: "This risk no longer applies." });
    expect(core.listModuleNarratives()[0]).toMatchObject({ id: narrative.id, current: false });
    expect(core.rebuildModuleNarratives({ modules: ["src/cli"] })).toMatchObject({ deleted: 1, narratives: [] });
    expect(core.listModuleNarratives()).toEqual([]);
    core.close();
  });

  it("carries prior stale-file facts forward, deduplicates replacements, and removes invalid sources", () => {
    const moduleDirectory = join(repository, "src", "math");
    const moduleFile = join(moduleDirectory, "index.ts");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(moduleFile, "export const subtract = (a: number, b: number) => a - b;\n");

    const core = new RepositoryMemoryCore(repository);
    const subtract = core.record({
      type: "solution",
      title: "Subtract operation",
      content: "The math module exports subtract(a, b).",
      relatedFiles: ["src/math/index.ts"],
    });
    const first = core.rebuildModuleNarratives().narratives[0]!;
    expect(first).toMatchObject({ modulePath: "src/math", sourceMemoryIds: [subtract.id], version: 1 });

    writeFileSync(moduleFile, [
      "export const subtract = (a: number, b: number) => a - b;",
      "export const multiply = (a: number, b: number) => a * b;",
      "",
    ].join("\n"));
    expect(core.search("subtract operation")[0]).toMatchObject({ id: subtract.id, status: "uncertain" });
    const multiply = core.record({
      type: "solution",
      title: "Multiply operation",
      content: "The math module exports multiply(a, b).",
      relatedFiles: ["src/math/index.ts"],
    });

    const merged = core.rebuildModuleNarratives().narratives[0]!;
    expect(merged).toMatchObject({ version: 2, sourceCount: 2 });
    expect(merged.sourceMemoryIds).toEqual(expect.arrayContaining([subtract.id, multiply.id]));
    expect(merged.content).toContain("subtract(a, b)");
    expect(merged.content).toContain("multiply(a, b)");
    expect(merged.content).toContain("[stale: verify against current files]");

    const replacement = core.record({
      type: "solution",
      title: "Current subtract operation",
      // L1 treats internal whitespace as fingerprint-significant; L2 normalizes it for fact deduplication.
      content: "The math module exports  subtract(a, b).",
      relatedFiles: ["src/math/index.ts"],
    });
    const deduplicated = core.rebuildModuleNarratives().narratives[0]!;
    expect(deduplicated).toMatchObject({ version: 3, sourceCount: 2 });
    expect(deduplicated.sourceMemoryIds).toEqual(expect.arrayContaining([replacement.id, multiply.id]));
    expect(deduplicated.sourceMemoryIds).not.toContain(subtract.id);
    expect(deduplicated.content.match(/subtract\(a, b\)/gu)).toHaveLength(1);

    core.invalidateMemory({ memoryId: replacement.id, reason: "subtract is no longer exported" });
    const withoutInvalid = core.rebuildModuleNarratives().narratives[0]!;
    expect(withoutInvalid).toMatchObject({ version: 4, sourceCount: 1, sourceMemoryIds: [multiply.id] });
    expect(withoutInvalid.content).not.toContain("subtract(a, b)");
    expect(withoutInvalid.content).toContain("multiply(a, b)");
    core.close();
  });

  it("requires an explicit module identity for module-scoped L1", () => {
    const core = new RepositoryMemoryCore(repository);
    expect(() => core.record({
      type: "architecture", title: "Unknown module", content: "This has no module identity.", scopeType: "module",
    })).toThrow(/module scope requires scopeValue/u);
    core.close();
  });
});
