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
