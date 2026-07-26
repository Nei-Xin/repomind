import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository, git } from "./helpers.js";

describe("forgetting memories", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("physically deletes the memory, its index entries, and orphaned evidence", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Temporary convention",
      content: "This memory exists only to be forgotten.",
    });
    expect(core.search("forgotten")).toHaveLength(1);

    const result = core.forgetMemory({ memoryId: recorded.id, reason: "User requested removal" });
    expect(result).toEqual({ memoryId: recorded.id, scope: "memory-and-evidence", evidenceDeleted: 1 });

    expect(core.search("forgotten")).toEqual([]);
    expect(() => core.inspect(recorded.id)).toThrow(/was not found/);
    const db = core.context.database.raw;
    expect(db.prepare("SELECT count(*) AS count FROM evidence").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM memory_fts WHERE memory_id=?").get(recorded.id)).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT memory_id, scope, evidence_deleted, reason FROM forget_log").get()).toMatchObject({
      memory_id: recorded.id,
      scope: "memory-and-evidence",
      evidence_deleted: 1,
      reason: "User requested removal",
    });
    core.close();
  });

  it("keeps evidence that other memories still reference", () => {
    const core = new RepositoryMemoryCore(repository);
    const session = core.startSession({ task: "Improve the storage layer" });
    writeFileSync(join(repository, "storage.txt"), "storage\n", "utf8");
    git(repository, "add", "storage.txt");
    git(repository, "commit", "-m", "add storage");
    core.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "forget-shared-1",
      status: "success",
      summary: "Reworked the storage layer bootstrap",
      decisions: ["Storage bootstrap happens in a single module"],
    });

    const solution = core.search("Reworked storage layer", { types: ["solution"] })[0]!;
    const decision = core.search("bootstrap single module", { types: ["decision"] })[0]!;
    const db = core.context.database.raw;
    const sharedEvidence = db.prepare(
      "SELECT evidence_id FROM memory_evidence WHERE memory_id=? INTERSECT SELECT evidence_id FROM memory_evidence WHERE memory_id=?",
    ).all(solution.id, decision.id) as Array<{ evidence_id: string }>;
    expect(sharedEvidence.length).toBeGreaterThan(0);

    const result = core.forgetMemory({ memoryId: solution.id, reason: "Summary was wrong" });
    expect(result.evidenceDeleted).toBeGreaterThan(0);
    for (const shared of sharedEvidence) {
      expect(db.prepare("SELECT count(*) AS count FROM evidence WHERE id=?").get(shared.evidence_id)).toMatchObject({ count: 1 });
    }
    expect(core.inspect(decision.id).evidence).toHaveLength(1);
    core.close();
  });

  it("keeps all evidence when the scope is memory only", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "command",
      title: "Old build command",
      content: "Use the retired build command.",
    });
    const result = core.forgetMemory({ memoryId: recorded.id, reason: "Keep the trace", scope: "memory" });
    expect(result).toEqual({ memoryId: recorded.id, scope: "memory", evidenceDeleted: 0 });
    const db = core.context.database.raw;
    expect(db.prepare("SELECT count(*) AS count FROM evidence").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM memories").get()).toMatchObject({ count: 0 });
    core.close();
  });
});
