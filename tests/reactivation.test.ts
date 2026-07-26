import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("re-recording retired memories", () => {
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

  it("reactivates an invalidated memory when the same fact is recorded again", () => {
    const core = new RepositoryMemoryCore(repository);
    const input = { type: "decision" as const, title: "Retry policy", content: "Retries use exponential backoff with jitter." };
    const first = core.record(input);
    core.invalidateMemory({ memoryId: first.id, reason: "Believed disproven by the incident review." });
    expect(core.search("exponential backoff jitter")).toEqual([]);

    const again = core.record(input);
    expect(again).toMatchObject({ id: first.id, stored: true, reactivated: true });
    const found = core.search("exponential backoff jitter");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: first.id, status: "active" });

    const details = core.inspect(first.id);
    expect(details.statusReason).toBeNull();
    expect(details.audit).toContainEqual(expect.objectContaining({ action: "memory_reactivated" }));
    // The invalidation itself stays in the audit trail.
    expect(details.audit).toContainEqual(expect.objectContaining({ action: "memory_invalidated" }));
    core.close();
  });

  it("reactivates a superseded memory, attaches new evidence, and conflicts with its replacement", () => {
    const core = new RepositoryMemoryCore(repository);
    const original = core.record({ type: "convention", title: "Import style", content: "Use named imports only." });
    const corrected = core.correctMemory({
      memoryId: original.id,
      reason: "The team briefly switched to default imports.",
      title: "Import style",
      content: "Use default imports.",
    });
    expect(core.inspect(original.id).status).toBe("superseded");

    const revived = core.record({ type: "convention", title: "Import style", content: "Use named imports only." });
    expect(revived).toMatchObject({ id: original.id, stored: true, reactivated: true, conflicts: [corrected.replacementMemoryId] });
    const details = core.inspect(original.id);
    // Reviving a fact its replacement contradicts must surface as a conflict,
    // never as a silently re-activated truth.
    expect(details.status).toBe("uncertain");
    expect(details.statusReason).toEqual({ kind: "conflict", withMemoryId: corrected.replacementMemoryId });
    expect((details.evidence as unknown[]).length).toBeGreaterThan(1);
    expect(details.audit).toContainEqual(expect.objectContaining({ action: "memory_reactivated" }));
    core.close();
  });

  it("does not reactivate a retired memory as the target of a correction", () => {
    const core = new RepositoryMemoryCore(repository);
    const retired = core.record({ type: "decision", title: "Queue choice", content: "Use the legacy queue." });
    core.invalidateMemory({ memoryId: retired.id, reason: "The legacy queue was removed." });
    const live = core.record({ type: "decision", title: "Queue choice v2", content: "Use the managed queue." });

    expect(() => core.correctMemory({
      memoryId: live.id,
      reason: "Reverting to the previous wording.",
      title: "Queue choice",
      content: "Use the legacy queue.",
    })).toThrow(/is invalid/);
    expect(core.inspect(retired.id).status).toBe("invalid");
    expect(core.inspect(live.id).status).toBe("active");
    core.close();
  });

  it("does not reactivate retired memories from automatic extraction", () => {
    const core = new RepositoryMemoryCore(repository);
    const decision = "Storage bootstrap happens in a single module";
    const seeded = core.record({ type: "decision", title: decision, content: decision });
    core.invalidateMemory({ memoryId: seeded.id, reason: "Superseded by the modular bootstrap." });

    const session = core.startSession({ task: "Revisit the storage bootstrap" });
    const result = core.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "reactivation-1",
      status: "success",
      summary: "Revisited the storage bootstrap",
      decisions: [decision],
    });
    expect(result.memories.skipped).toBeGreaterThan(0);
    expect(core.inspect(seeded.id).status).toBe("invalid");
    core.close();
  });

  it("still deduplicates against live memories without reactivating", () => {
    const core = new RepositoryMemoryCore(repository);
    const input = { type: "convention" as const, title: "Live rule", content: "This rule is still in force." };
    const first = core.record(input);
    const second = core.record(input);
    expect(second).toMatchObject({ id: first.id, stored: false, reactivated: false });
    core.close();
  });
});
