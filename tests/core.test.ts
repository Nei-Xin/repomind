import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("detects a same-size edit that lands in the same filesystem tick", () => {
    // The stale-detection fast path trusts unchanged size+mtime. An edit of
    // identical length written immediately after recording can keep both
    // values identical, so recently touched files must still be re-hashed.
    writeFileSync(join(repository, "config.txt"), "timeout=30\n", "utf8");
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "dependency",
      title: "Configured timeout",
      content: "The service timeout lives in config.txt.",
      relatedFiles: ["config.txt"],
    });
    writeFileSync(join(repository, "config.txt"), "timeout=60\n", "utf8");

    const result = core.search("service timeout")[0]!;
    expect(result).toMatchObject({
      id: recorded.id,
      status: "uncertain",
      staleReasons: [{ kind: "file_modified", filePath: "config.txt" }],
    });
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

  it("does not fingerprint related files through links that escape the repository", () => {
    const outside = join(data, "outside-related-files");
    mkdirSync(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "external secret v1\n", "utf8");
    symlinkSync(outside, join(repository, "external-directory"), process.platform === "win32" ? "junction" : "dir");

    const core = new RepositoryMemoryCore(repository);
    try {
      const linkedDirectory = core.record({
        type: "risk",
        title: "External directory link",
        content: "Do not use repository links to read external files.",
        relatedFiles: ["external-directory/secret.txt"],
      });
      expect(core.inspect(linkedDirectory.id)).toMatchObject({
        files: [{ file_path: "external-directory/secret.txt", file_hash: null }],
      });

      writeFileSync(secret, "external secret v2 with different content\n", "utf8");
      expect(core.search("repository links external files")[0]).toMatchObject({
        id: linkedDirectory.id,
        status: "active",
      });
      expect(core.inspect(linkedDirectory.id)).toMatchObject({
        files: [{ file_path: "external-directory/secret.txt", file_hash: null }],
      });

      const initiallyMissing = core.record({
        type: "location",
        title: "Future external directory link",
        content: "A missing related path must stay unavailable if replaced by an external link.",
        relatedFiles: ["future-external/secret.txt"],
      });
      symlinkSync(outside, join(repository, "future-external"), process.platform === "win32" ? "junction" : "dir");
      expect(core.search("missing related path unavailable")[0]).toMatchObject({
        id: initiallyMissing.id,
        status: "active",
      });
      expect(core.inspect(initiallyMissing.id)).toMatchObject({
        files: [{ file_path: "future-external/secret.txt", file_hash: null }],
      });

      if (process.platform !== "win32") {
        symlinkSync(secret, join(repository, "external-file.txt"), "file");
        const linkedFile = core.record({
          type: "risk",
          title: "External file link",
          content: "Do not fingerprint a related file symlink that leaves the repository.",
          relatedFiles: ["external-file.txt"],
        });
        expect(core.inspect(linkedFile.id)).toMatchObject({
          files: [{ file_path: "external-file.txt", file_hash: null }],
        });
      }
    } finally {
      core.close();
    }
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

  it("keeps a newer extracted decision active while making its old subject conflict uncertain", () => {
    const core = new RepositoryMemoryCore(repository);
    try {
      const firstFile = join(repository, "README.txt");
      const first = core.startSession({ task: "Define the windowMs validation rule" });
      writeFileSync(firstFile, "windowMs rejects invalid values.\n", "utf8");
      core.commitSession({
        sessionId: first.sessionId,
        idempotencyKey: "decision-replacement-1",
        status: "success",
        summary: "`windowMs` 为零、负数或小数抛出 `RangeError`。",
      });
      core.context.database.raw.prepare("UPDATE memories SET title=? WHERE content=?")
        .run("Technical decision: `windowMs` 为零、负数或小数抛出 `RangeError`", "`windowMs` 为零、负数或小数抛出 `RangeError`。");

      const second = core.startSession({ task: "Revise the windowMs validation rule" });
      const moduleFile = join(repository, "src", "rate-limit", "index.js");
      mkdirSync(join(repository, "src", "rate-limit"), { recursive: true });
      writeFileSync(moduleFile, "windowMs accepts fractional values.\n", "utf8");
      core.commitSession({
        sessionId: second.sessionId,
        idempotencyKey: "decision-replacement-2",
        status: "success",
        summary: "`windowMs` 现在允许正的有限数，包括小数。\n零和负数仍抛出 `RangeError`。",
      });

      const recall = core.startSession({ task: "Only answer from recalled memory" });
      core.commitSession({
        sessionId: recall.sessionId,
        idempotencyKey: "decision-recall",
        status: "success",
        summary: "`windowMs` 为零和负数时抛出 `RangeError`。",
      });

      const decisions = core.search("windowMs", { types: ["decision"], limit: 20 });
      expect(decisions).toHaveLength(2);
      expect(decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("`windowMs` 现在允许正的有限数，包括小数。"),
          status: "active",
          scopeType: "module",
          scopeValue: "src/rate-limit",
        }),
        expect.objectContaining({
          content: "`windowMs` 为零、负数或小数抛出 `RangeError`。",
          status: "uncertain",
          scopeType: "repository",
        }),
      ]));
    } finally {
      core.close();
    }
  });

  it("keeps full test Evidence while deduplicating compact verified-command memories", () => {
    const core = new RepositoryMemoryCore(repository);
    const commit = (key: string, duration: string): void => {
      const started = core.startSession({ task: "Verify the delivery contract" });
      core.commitSession({
        sessionId: started.sessionId,
        idempotencyKey: key,
        status: "success",
        summary: "Verified the delivery contract without changing repository files.",
        tests: [{
          command: "node --test",
          exitCode: 0,
          summary: [
            "TAP version 13",
            "# Subtest: delivery remains retryable",
            `# duration_ms ${duration}`,
            "# tests 4",
            "# pass 4",
            "# fail 0",
            "# skipped 0",
          ].join("\n"),
        }],
      });
    };

    commit("compact-command-1", "123.45");
    commit("compact-command-2", "987.65");
    const commands = core.search("node test verified command", { types: ["command"], limit: 20 });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.content).toBe([
      "Command: \"node --test\"",
      "Result: passed (exit code 0)",
      "Summary: tests 4; pass 4; fail 0; skipped 0",
    ].join("\n"));
    const evidence = core.context.database.raw.prepare(
      "SELECT content FROM evidence WHERE kind='test_result' ORDER BY created_at, id",
    ).all() as Array<{ content: string }>;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.content).toContain("123.45");
    expect(evidence[1]!.content).toContain("987.65");
    core.close();
  });

  it("keeps deleted paths in diff Evidence without assigning them to extracted memories", () => {
    mkdirSync(join(repository, "ops"));
    writeFileSync(join(repository, "ops", "completed-review.txt"), "Retire this completed review.\n", "utf8");
    git(repository, "add", "ops/completed-review.txt");
    git(repository, "commit", "-m", "add completed review");

    const core = new RepositoryMemoryCore(repository);
    const started = core.startSession({ task: "Close the completed review" });
    rmSync(join(repository, "ops", "completed-review.txt"));
    core.commitSession({
      sessionId: started.sessionId,
      idempotencyKey: "delete-only-memory-files",
      status: "success",
      summary: "Closed the review and preserved its durable conclusion for the next maintainer.",
      tests: [{ command: "node --test", exitCode: 0, summary: "tests 4; pass 4; fail 0" }],
    });

    const extractedFiles = core.context.database.raw.prepare(`
      SELECT mf.file_path
      FROM memories m LEFT JOIN memory_files mf ON mf.memory_id=m.id
      WHERE m.source='extracted'
    `).all() as Array<{ file_path: string | null }>;
    expect(extractedFiles).toHaveLength(2);
    expect(extractedFiles.every((row) => row.file_path === null)).toBe(true);
    const diffEvidence = core.context.database.raw.prepare(
      "SELECT metadata_json FROM evidence WHERE kind='git_diff'",
    ).get() as { metadata_json: string };
    expect(JSON.parse(diffEvidence.metadata_json)).toMatchObject({ files: ["ops/completed-review.txt"] });
    expect(core.rebuildModuleNarratives()).toMatchObject({ created: 0, narratives: [] });
    core.close();
  });

  it("associates extracted memories only with files changed during the session", () => {
    writeFileSync(join(repository, "unrelated.txt"), "clean unrelated\n", "utf8");
    writeFileSync(join(repository, "task.txt"), "clean task\n", "utf8");
    git(repository, "add", "unrelated.txt", "task.txt");
    git(repository, "commit", "-m", "add task scope fixtures");
    writeFileSync(join(repository, "unrelated.txt"), "pre-existing unrelated edit\n", "utf8");

    const core = new RepositoryMemoryCore(repository);
    const started = core.startSession({ task: "Update the task-scoped behavior" });
    writeFileSync(join(repository, "task.txt"), "task-specific edit\n", "utf8");
    core.commitSession({
      sessionId: started.sessionId,
      idempotencyKey: "task-file-scope-1",
      status: "success",
      summary: "Updated the task-scoped behavior.",
    });

    const linkedFiles = core.context.database.raw.prepare(`
      SELECT DISTINCT mf.file_path
      FROM memories m JOIN memory_files mf ON mf.memory_id=m.id
      WHERE m.source='extracted'
      ORDER BY mf.file_path
    `).all() as Array<{ file_path: string }>;
    expect(linkedFiles).toEqual([{ file_path: "task.txt" }]);
    const diffEvidence = core.context.database.raw.prepare(
      "SELECT content, metadata_json FROM evidence WHERE kind='git_diff'",
    ).get() as { content: string; metadata_json: string };
    expect(diffEvidence.content).toContain("task-specific edit");
    expect(diffEvidence.content).not.toContain("pre-existing unrelated edit");
    expect(JSON.parse(diffEvidence.metadata_json)).toMatchObject({ files: ["task.txt"] });
    core.close();
  });

  it("disables L1 recall at maxMemories zero while preserving current L2 and L3", async () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Release workflow ownership",
      content: "The release module owns the verified release workflow.",
      confidence: 0.95,
      scopeType: "module",
      scopeValue: "src/release",
    });
    const narrative = core.rebuildModuleNarratives().narratives[0]!;
    const profile = core.rebuildRepositoryProfile().profile;

    const lexical = core.startSession({ task: "Run the release workflow", maxMemories: 0 });
    expect(lexical.memories).toEqual([]);
    expect(lexical.moduleNarratives).toEqual([expect.objectContaining({ id: narrative.id, current: true })]);
    expect(lexical.repositoryProfile).toMatchObject({ id: profile.id, current: true });

    const hybrid = await core.startSessionHybrid({ task: "Run the release workflow", maxMemories: 0 });
    expect(hybrid.memories).toEqual([]);
    expect(hybrid.moduleNarratives).toEqual([expect.objectContaining({ id: narrative.id, current: true })]);
    expect(hybrid.repositoryProfile).toMatchObject({ id: profile.id, current: true });
    expect(core.search("release workflow")).toEqual([expect.objectContaining({ id: recorded.id })]);

    core.abandonSession(lexical.sessionId);
    core.abandonSession(hybrid.sessionId);
    core.close();
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
