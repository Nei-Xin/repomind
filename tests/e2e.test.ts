import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository } from "./helpers.js";
import { git } from "./helpers.js";
import { runOpenCodeHost } from "../src/integrations/opencode/run.js";

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

  it("reviews and applies bootstrap candidates across CLI processes", () => {
    writeFileSync(join(repository, "README.md"), "# Payment router\n\nRoutes use idempotency keys before dispatching payment requests.\n", "utf8");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "document payment routing");
    JSON.parse(cli(repository, data, "init"));
    const candidatesPath = join(data, "bootstrap.json");
    const generated = JSON.parse(cli(repository, data, "bootstrap", "--output", candidatesPath)) as { candidates: number; bundle: { candidates: Array<{ id: string; source: { kind: string } }> } };
    expect(generated.candidates).toBeGreaterThanOrEqual(2);
    expect(generated.bundle.candidates.some((entry) => entry.source.kind === "readme")).toBe(true);
    expect(JSON.parse(cli(repository, data, "search", "idempotency dispatch"))).toEqual([]);

    const readme = generated.bundle.candidates.find((entry) => entry.source.kind === "readme")!;
    const applied = JSON.parse(cli(repository, data, "bootstrap-apply", "--input", candidatesPath, "--candidate", readme.id, "--yes")) as { stored: number; selected: number };
    expect(applied).toMatchObject({ stored: 1, selected: 1 });
    expect(JSON.parse(cli(repository, data, "search", "idempotency dispatch"))).toEqual([
      expect.objectContaining({ title: "Payment router", tags: expect.arrayContaining(["bootstrap", "readme"]) }),
    ]);
  });

  it("lists and inspects persisted host runs across CLI processes", async () => {
    JSON.parse(cli(repository, data, "init"));
    const report = await runOpenCodeHost({
      repository,
      task: "Inspect a daily host run",
      dataDirectory: data,
      outputDirectory: join(data, "run-output"),
      model: "test/model",
      execute: async () => ({
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ type: "text", part: { text: "Inspected the daily host run." } })}\n`,
        stderr: "",
        durationMs: 5,
        timedOut: false,
        aborted: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    });
    const runs = JSON.parse(cli(repository, data, "runs", "--status", "committed", "--limit", "5")) as Array<{ id: string }>;
    expect(runs).toEqual([expect.objectContaining({ id: report.runId })]);
    const inspected = JSON.parse(cli(repository, data, "run-inspect", report.runId)) as { id: string; model: string; reportPath: string };
    expect(inspected).toMatchObject({ id: report.runId, model: "test/model", reportPath: report.artifacts.report });
  });
});
