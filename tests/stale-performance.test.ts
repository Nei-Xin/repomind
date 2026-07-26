import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync: typeof actual.readFileSync = (path, ...rest) => {
    if (typeof path === "string") reads.push(path);
    return (actual.readFileSync as (...args: unknown[]) => never)(path, ...rest);
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { RepositoryMemoryCore } = await import("../src/core.js");
const { initializeRepository } = await import("../src/repository.js");
const { createTestRepository } = await import("./helpers.js");

describe("staleness refresh cost", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
    reads.length = 0;
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("reads a shared related file once per refresh instead of once per memory", () => {
    const core = new RepositoryMemoryCore(repository);
    for (let index = 0; index < 5; index++) {
      core.record({
        type: "convention",
        title: `Shared file rule ${index}`,
        content: `Rule ${index} documents the shared readme.`,
        relatedFiles: ["README.txt"],
      });
    }
    writeFileSync(join(repository, "README.txt"), "changed once\n", "utf8");

    reads.length = 0;
    const results = core.search("shared readme");
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((memory) => memory.status === "uncertain")).toBe(true);
    expect(reads.filter((path) => path.endsWith("README.txt"))).toHaveLength(1);
    core.close();
  });

  it("skips re-hashing entirely once a file's size and mtime have settled", async () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({
      type: "convention",
      title: "Settled file rule",
      content: "This rule points at a file that stops changing.",
      relatedFiles: ["README.txt"],
    });
    // The fast path deliberately distrusts recently touched files, so wait past
    // the racy-mtime window before asserting that no read happens at all.
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    core.search("settled file rule");
    reads.length = 0;
    core.search("settled file rule");
    expect(reads.filter((path) => path.endsWith("README.txt"))).toEqual([]);
    expect(core.search("settled file rule")[0]).toMatchObject({ status: "active" });
    core.close();
  });
});
