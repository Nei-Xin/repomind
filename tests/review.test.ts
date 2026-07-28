import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import type { MemoryReviewKind } from "../src/domain/types.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("memory maintenance review", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-review-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("classifies pending memories and closes the queue through governance actions", () => {
    const core = new RepositoryMemoryCore(repository);
    const stale = core.record({
      type: "convention",
      title: "Readme contract",
      content: "The readme defines the public contract.",
      relatedFiles: ["README.txt"],
    });
    const first = core.record({ type: "decision", title: "Queue backend", content: "Use SQLite for the queue." });
    const second = core.record({ type: "decision", title: "Queue backend", content: "Use PostgreSQL for the queue." });
    writeFileSync(join(repository, "README.txt"), "updated contract\n", "utf8");

    const queue = core.review();
    expect(queue).toMatchObject({
      filter: "all",
      pending: 3,
      returned: 3,
      counts: { stale: 1, conflict: 2, other: 0 },
    });
    expect(queue.items.find((item) => item.id === stale.id)).toMatchObject({
      kind: "stale",
      evidenceCount: 1,
      relatedFiles: [{ filePath: "README.txt", fileHash: expect.any(String) }],
      statusReason: { kind: "stale_files", files: [{ kind: "file_modified" }] },
      suggestedCommands: { inspect: `repomind inspect ${stale.id}` },
    });
    expect(queue.items.find((item) => item.id === first.id)).toMatchObject({
      kind: "conflict",
      statusReason: { kind: "conflict", withMemoryIds: [second.id] },
    });
    expect(core.review({ kind: "stale", limit: 1 })).toMatchObject({ returned: 1, pending: 3 });

    core.validateMemory({ memoryId: stale.id, reason: "The updated contract still supports this memory." });
    core.invalidateMemory({ memoryId: second.id, reason: "The repository uses SQLite, not PostgreSQL." });
    expect(core.review()).toMatchObject({ pending: 0, returned: 0, counts: { stale: 0, conflict: 0, other: 0 } });
    core.close();
  });

  it("rejects invalid filters and limits", () => {
    const core = new RepositoryMemoryCore(repository);
    expect(() => core.review({ limit: 0 })).toThrow(/integer from 1 to 200/u);
    expect(() => core.review({ kind: "retired" as MemoryReviewKind })).toThrow(/Invalid review kind/u);
    core.close();
  });
});
