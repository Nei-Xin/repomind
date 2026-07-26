import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("deterministic conflict detection", () => {
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

  it("marks contradicting declarative memories uncertain with a contradicts relation", () => {
    const core = new RepositoryMemoryCore(repository);
    const first = core.record({
      type: "decision",
      title: "Local storage engine",
      content: "Use SQLite as the local source of truth.",
    });
    const second = core.record({
      type: "decision",
      title: "Local storage engine",
      content: "Use PostgreSQL for local storage.",
    });
    expect(second).toMatchObject({ stored: true, conflicts: [first.id] });

    const results = core.search("Local storage engine");
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("uncertain");
      expect(result.warning).toContain("conflicts with memory");
    }

    const oldSide = core.inspect(first.id);
    expect(oldSide.statusReason).toEqual({ kind: "conflict", withMemoryId: second.id });
    expect(oldSide.relations).toContainEqual(expect.objectContaining({
      direction: "incoming",
      relation_type: "contradicts",
      related_memory_id: second.id,
    }));
    expect(oldSide.audit).toContainEqual(expect.objectContaining({ action: "memory_conflict_detected" }));

    const newSide = core.inspect(second.id);
    expect(newSide.statusReason).toEqual({ kind: "conflict", withMemoryId: first.id });
    expect(newSide.relations).toContainEqual(expect.objectContaining({
      direction: "outgoing",
      relation_type: "contradicts",
      related_memory_id: first.id,
    }));
    core.close();
  });

  it("does not flag episodic types or different scopes as conflicts", () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({ type: "command", title: "Build", content: "Run the legacy build script." });
    const command = core.record({ type: "command", title: "Build", content: "Run the current build script." });
    expect(command.conflicts).toEqual([]);

    core.record({ type: "convention", title: "Error handling", content: "Throw typed errors.", scopeType: "module", scopeValue: "storage" });
    const scoped = core.record({ type: "convention", title: "Error handling", content: "Return result objects.", scopeType: "module", scopeValue: "cli" });
    expect(scoped.conflicts).toEqual([]);
    expect(core.search("Build", { statuses: ["active"] })).toHaveLength(2);
    core.close();
  });

  it("counts conflicts in commit results", () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({
      type: "decision",
      title: "Use tabs for indentation",
      content: "Historical decision recorded before the style review.",
    });
    const session = core.startSession({ task: "Settle the indentation style" });
    const result = core.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "conflict-commit-1",
      status: "success",
      summary: "Settled the indentation style",
      decisions: ["Use tabs for indentation"],
    });
    expect(result.memories).toEqual({ stored: 2, skipped: 0, conflicts: 1 });
    core.close();
  });

  it("lets validation resolve one side while the other stays uncertain", () => {
    const core = new RepositoryMemoryCore(repository);
    const first = core.record({ type: "convention", title: "Import style", content: "Use default imports." });
    const second = core.record({ type: "convention", title: "Import style", content: "Use named imports only." });

    const validated = core.validateMemory({ memoryId: second.id, reason: "The named-import rule is the one the codebase follows." });
    expect(validated.status).toBe("active");
    expect(core.inspect(second.id).status).toBe("active");
    expect(core.inspect(first.id).status).toBe("uncertain");
    core.close();
  });

  it("does not conflict a correction with the memory it replaces", () => {
    const core = new RepositoryMemoryCore(repository);
    const original = core.record({ type: "decision", title: "Retry policy", content: "Retry three times." });
    const corrected = core.correctMemory({
      memoryId: original.id,
      reason: "The policy changed with the new queue.",
      title: "Retry policy",
      content: "Retry five times with exponential backoff.",
    });
    expect(corrected).toMatchObject({ status: "superseded", replacementStored: true });
    expect(core.inspect(corrected.replacementMemoryId).status).toBe("active");
    expect(core.inspect(original.id).status).toBe("superseded");
    core.close();
  });
});
