import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository } from "./helpers.js";

const CLI = resolve("dist/cli/index.js");

function cli(repository: string, data: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args, "--repo", repository, "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      REPOMIND_DATA_DIR: data,
      REPOMIND_EMBEDDING_PROVIDER: "deterministic",
      REPOMIND_EMBEDDING_DIMENSIONS: "64",
    },
  }).trim();
}

describe("cross-process CLI end-to-end", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-e2e-data-"));
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("persists memories across separate CLI processes", () => {
    expect(existsSync(CLI), "dist/cli/index.js is missing; run npm run build before npm test").toBe(true);

    const initialized = JSON.parse(cli(repository, data, "init")) as { projectId: string };
    expect(initialized.projectId).toBeTruthy();

    const started = JSON.parse(cli(repository, data, "start", "--task", "Fix the flaky storage test")) as { sessionId: string; retrievalStrategy: string };
    expect(started.sessionId).toMatch(/^ses_/);
    expect(started.retrievalStrategy).toBe("hybrid-fts5-vector");

    const committed = JSON.parse(cli(
      repository, data, "commit",
      "--session", started.sessionId,
      "--key", "e2e-1",
      "--summary", "Stabilized the storage test by resetting the database between cases",
    )) as { status: string; memories: { stored: number } };
    expect(committed.status).toBe("committed");
    expect(committed.memories.stored).toBeGreaterThan(0);

    // Every later call is a brand-new process; only the database persists.
    const found = JSON.parse(cli(repository, data, "search", "flaky storage test")) as Array<{ id: string; type: string }>;
    expect(found.length).toBeGreaterThan(0);
    const solution = found.find((memory) => memory.type === "solution");
    expect(solution).toBeDefined();

    const status = JSON.parse(cli(repository, data, "status")) as { embeddings: number; capabilities: { vector: boolean } };
    expect(status).toMatchObject({ embeddings: expect.any(Number), capabilities: { vector: true } });
    expect(status.embeddings).toBeGreaterThan(0);

    const inspected = JSON.parse(cli(repository, data, "inspect", solution!.id)) as { evidence: unknown[]; audit: unknown[] };
    expect(inspected.evidence.length).toBeGreaterThan(0);
    expect(inspected.audit.length).toBeGreaterThan(0);
  });
});
