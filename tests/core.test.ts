import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository, git } from "./helpers.js";

describe("repository memory core", () => {
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

  it("records, searches, and explains a manual memory", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Explicit public types",
      content: "Every public API exports an explicit TypeScript type.",
      tags: ["typescript", "api"],
      relatedFiles: ["README.txt"],
    });
    expect(recorded.stored).toBe(true);
    const results = core.search("public TypeScript");
    expect(results[0]).toMatchObject({ id: recorded.id, type: "convention", status: "active" });
    const details = core.inspect(recorded.id);
    expect(details.evidence).toHaveLength(1);
    expect(details.audit).toHaveLength(1);
    core.close();
  });

  it("marks a memory uncertain when a related file changes", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Stable readme rule",
      content: "Keep the repository readme stable.",
      relatedFiles: ["README.txt"],
    });

    expect(core.search("repository readme")[0]).toMatchObject({ status: "active" });
    writeFileSync(join(repository, "README.txt"), "changed\n", "utf8");

    const stale = core.search("repository readme")[0]!;
    expect(stale).toMatchObject({
      id: recorded.id,
      status: "uncertain",
      warning: "This memory may be stale: README.txt changed.",
      staleReasons: [{
        kind: "file_modified",
        filePath: "README.txt",
        expectedHash: expect.any(String),
        currentHash: expect.any(String),
      }],
    });
    expect(core.search("repository readme", { statuses: ["active"] })).toEqual([]);

    const inspected = core.inspect(recorded.id);
    expect(inspected).toMatchObject({
      status: "uncertain",
      warning: "This memory may be stale: README.txt changed.",
      statusReason: { kind: "stale_files", files: [{ kind: "file_modified", filePath: "README.txt" }] },
    });
    expect(inspected.audit).toHaveLength(2);
    expect(inspected.audit).toContainEqual(expect.objectContaining({
      action: "memory_marked_uncertain",
      reason: "This memory may be stale: README.txt changed.",
    }));
    expect(core.status()).toMatchObject({ uncertainMemories: 1, capabilities: { staleDetection: "file-hash" } });

    core.search("repository readme");
    expect(core.inspect(recorded.id).audit).toHaveLength(2);
    core.close();
  });

  it("detects deleted and newly created related files without affecting unlinked memories", () => {
    const core = new RepositoryMemoryCore(repository);
    const deleted = core.record({
      type: "location",
      title: "Readme location",
      content: "The documentation lives in README.txt.",
      relatedFiles: ["README.txt"],
    });
    const created = core.record({
      type: "location",
      title: "Future configuration",
      content: "The future configuration lives in future.json.",
      relatedFiles: ["future.json"],
    });
    const unlinked = core.record({
      type: "convention",
      title: "General naming rule",
      content: "Use explicit configuration names.",
    });

    rmSync(join(repository, "README.txt"));
    writeFileSync(join(repository, "future.json"), "{}\n", "utf8");

    expect(core.search("documentation lives")[0]).toMatchObject({
      id: deleted.id,
      status: "uncertain",
      staleReasons: [{ kind: "file_deleted", filePath: "README.txt", currentHash: null }],
    });
    expect(core.search("future configuration")[0]).toMatchObject({
      id: created.id,
      status: "uncertain",
      staleReasons: [{ kind: "file_created", filePath: "future.json", expectedHash: null }],
    });
    expect(core.search("explicit configuration names")[0]).toMatchObject({ id: unlinked.id, status: "active" });
    core.close();
  });

  it("validates an uncertain memory against the current file hashes", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Validated readme rule",
      content: "The readme documents validation behavior.",
      relatedFiles: ["README.txt"],
    });
    writeFileSync(join(repository, "README.txt"), "accepted state\n", "utf8");
    expect(core.search("validation behavior")[0]).toMatchObject({ status: "uncertain" });

    const validated = core.validateMemory({ memoryId: recorded.id, reason: "Reviewed the updated documentation." });
    expect(validated).toMatchObject({
      memoryId: recorded.id,
      status: "active",
      files: [{ filePath: "README.txt", fileHash: expect.any(String) }],
    });
    expect(core.search("validation behavior", { statuses: ["active"] })[0]).toMatchObject({ id: recorded.id, status: "active" });
    const inspected = core.inspect(recorded.id);
    expect(inspected).toMatchObject({ status: "active", statusReason: null, last_validated_at: validated.lastValidatedAt });
    expect(inspected.audit).toContainEqual(expect.objectContaining({ action: "memory_validated", reason: "Reviewed the updated documentation." }));
    expect(inspected.evidence).toContainEqual(expect.objectContaining({ kind: "validation" }));

    writeFileSync(join(repository, "README.txt"), "changed again\n", "utf8");
    expect(core.search("validation behavior")[0]).toMatchObject({
      status: "uncertain",
      staleReasons: [{ kind: "file_modified", expectedHash: validated.files[0]!.fileHash }],
    });
    core.close();
  });

  it("corrects a memory by superseding it with an evidence-linked replacement", () => {
    const core = new RepositoryMemoryCore(repository);
    const original = core.record({
      type: "decision",
      title: "Legacy migration decision",
      content: "Run migrations without a transaction.",
      relatedFiles: ["README.txt"],
    });

    const corrected = core.correctMemory({
      memoryId: original.id,
      reason: "Rollback safety requires transactional migrations.",
      title: "Transactional migration decision",
      content: "Run every migration inside a transaction.",
    });
    expect(corrected).toMatchObject({ memoryId: original.id, status: "superseded", replacementStored: true });
    expect(corrected.replacementMemoryId).not.toBe(original.id);
    expect(core.search("without a transaction").map((memory) => memory.id)).not.toContain(original.id);
    expect(core.search("every migration transaction")[0]).toMatchObject({ id: corrected.replacementMemoryId, status: "active" });

    const oldDetails = core.inspect(original.id);
    expect(oldDetails).toMatchObject({
      status: "superseded",
      statusReason: {
        kind: "superseded",
        replacementMemoryId: corrected.replacementMemoryId,
        reason: "Rollback safety requires transactional migrations.",
      },
    });
    expect(oldDetails.relations).toContainEqual(expect.objectContaining({
      direction: "incoming",
      relation_type: "supersedes",
      related_memory_id: corrected.replacementMemoryId,
    }));
    expect(oldDetails.audit).toContainEqual(expect.objectContaining({ action: "memory_corrected" }));
    expect(oldDetails.evidence).toContainEqual(expect.objectContaining({ kind: "correction" }));

    const replacementDetails = core.inspect(corrected.replacementMemoryId);
    expect(replacementDetails.relations).toContainEqual(expect.objectContaining({
      direction: "outgoing",
      relation_type: "supersedes",
      related_memory_id: original.id,
    }));
    expect(core.status()).toMatchObject({ memories: 2, supersededMemories: 1 });
    expect(() => core.correctMemory({
      memoryId: original.id,
      reason: "Try correcting twice.",
      title: "Another correction",
      content: "This transition must fail.",
    })).toThrow(/cannot be corrected while superseded/u);
    core.close();
  });

  it("invalidates a memory while preserving its evidence and audit history", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "failure",
      title: "Incorrect failure diagnosis",
      content: "The migration fails because SQLite is unavailable.",
    });

    expect(core.invalidateMemory({ memoryId: recorded.id, reason: "The diagnosis was disproven by test evidence." }))
      .toEqual({ memoryId: recorded.id, status: "invalid" });
    expect(core.search("SQLite unavailable")).toEqual([]);
    const details = core.inspect(recorded.id);
    expect(details).toMatchObject({
      status: "invalid",
      statusReason: { kind: "invalid", reason: "The diagnosis was disproven by test evidence." },
    });
    expect(details.evidence).toContainEqual(expect.objectContaining({ kind: "invalidation" }));
    expect(details.audit).toContainEqual(expect.objectContaining({ action: "memory_invalidated" }));
    expect(core.status()).toMatchObject({ invalidMemories: 1 });
    expect(() => core.validateMemory({ memoryId: recorded.id, reason: "Invalid memories cannot be revalidated." }))
      .toThrow(/cannot be validated while invalid/u);
    core.close();
  });

  it("recalls evidence-backed memories in a new process-equivalent core", () => {
    const first = new RepositoryMemoryCore(repository);
    const started = first.startSession({ task: "Fix the SQLite loader on Windows", clientName: "test" });
    writeFileSync(join(repository, "README.txt"), "initial\nSQLite loader is architecture-aware.\n", "utf8");
    const committed = first.commitSession({
      sessionId: started.sessionId,
      idempotencyKey: "turn-1",
      status: "success",
      summary: "Fixed the Windows SQLite loader architecture check.",
      decisions: ["Validate native module architecture before loading SQLite extensions."],
      tests: [{ command: "npm test -- sqlite-loader", exitCode: 0, summary: "12 tests passed" }],
    });
    expect(committed.memories.stored).toBe(3);
    const repeated = first.commitSession({
      sessionId: started.sessionId,
      idempotencyKey: "turn-1",
      status: "success",
      summary: "Fixed the Windows SQLite loader architecture check.",
      decisions: ["Validate native module architecture before loading SQLite extensions."],
      tests: [{ command: "npm test -- sqlite-loader", exitCode: 0, summary: "12 tests passed" }],
    });
    expect(repeated).toEqual(committed);
    first.close();

    const second = new RepositoryMemoryCore(repository);
    const recalled = second.search("SQLite architecture");
    expect(recalled.length).toBeGreaterThan(0);
    const details = second.inspect(recalled[0]!.id);
    expect((details.evidence as unknown[]).length).toBeGreaterThan(0);
    expect(details.files).toContainEqual(expect.objectContaining({ file_path: "README.txt", file_hash: expect.any(String) }));
    expect(second.status()).toMatchObject({ sessions: 1, memories: 3, openSessions: 0 });
    second.close();
  });

  it("strictly isolates repositories", () => {
    const otherRepository = createTestRepository("repomind-other-");
    try {
      initializeRepository(otherRepository).database.close();
      const first = new RepositoryMemoryCore(repository);
      first.record({ type: "decision", title: "Private decision", content: "Use a repository-specific adapter." });
      first.close();
      const second = new RepositoryMemoryCore(otherRepository);
      expect(second.search("repository-specific adapter")).toEqual([]);
      second.close();
    } finally {
      rmSync(otherRepository, { recursive: true, force: true });
    }
  });

  it("captures commits created between the baseline and final HEAD", () => {
    const core = new RepositoryMemoryCore(repository);
    const started = core.startSession({ task: "Document committed migration behavior" });
    writeFileSync(join(repository, "README.txt"), "initial\ncommitted migration validation\n", "utf8");
    git(repository, "add", "README.txt");
    git(repository, "commit", "-m", "document migration validation");

    const committed = core.commitSession({
      sessionId: started.sessionId,
      idempotencyKey: "committed-diff-1",
      status: "success",
      summary: "Documented committed migration validation.",
    });
    expect(committed.evidenceCreated).toBe(3);
    const memory = core.search("committed migration validation")[0]!;
    const details = core.inspect(memory.id);
    const diffEvidence = (details.evidence as Array<Record<string, unknown>>).find((item) => item.kind === "git_diff");
    expect(diffEvidence?.content_preview).toContain("committed migration validation");
    expect(JSON.parse(String(diffEvidence?.metadata_json))).toMatchObject({ sources: ["committed"] });
    core.close();
  });

  it("captures the complete tree when a session starts before the first Git commit", () => {
    const emptyRepository = mkdtempSync(join(tmpdir(), "repomind-empty-repo-"));
    try {
      git(emptyRepository, "init", "-b", "main");
      git(emptyRepository, "config", "user.email", "repomind-test@example.invalid");
      git(emptyRepository, "config", "user.name", "RepoMind Test");
      initializeRepository(emptyRepository).database.close();
      const core = new RepositoryMemoryCore(emptyRepository);
      const started = core.startSession({ task: "Create the repository baseline" });
      expect(started.baseline.head).toBeNull();
      writeFileSync(join(emptyRepository, "FIRST.txt"), "first committed content\n", "utf8");
      git(emptyRepository, "add", ".");
      git(emptyRepository, "commit", "-m", "initial repository commit");
      core.commitSession({
        sessionId: started.sessionId,
        idempotencyKey: "first-commit-1",
        status: "success",
        summary: "Created the initial repository baseline.",
      });
      const memory = core.search("initial repository baseline")[0]!;
      const details = core.inspect(memory.id);
      const diffEvidence = (details.evidence as Array<Record<string, unknown>>).find((item) => item.kind === "git_diff");
      expect(diffEvidence?.content_preview).toContain("first committed content");
      core.close();
    } finally {
      rmSync(emptyRepository, { recursive: true, force: true });
    }
  });
});
