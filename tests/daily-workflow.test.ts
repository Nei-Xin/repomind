import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBootstrapBundle, generateBootstrapBundle } from "../src/bootstrap.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { runOpenCodeHost, type OpenCodeProcessExecutor } from "../src/integrations/opencode/run.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository, git } from "./helpers.js";

function withDataDirectory<T>(dataDirectory: string, action: () => T): T {
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

function successfulAgent(text: string, mutate?: () => void): OpenCodeProcessExecutor {
  return async () => {
    mutate?.();
    return {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ type: "text", part: { text } })}\n`,
      stderr: "",
      durationMs: 10,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };
}

describe("realistic daily memory workflow", () => {
  let repository: string | undefined;
  let scratch: string | undefined;

  afterEach(() => {
    if (repository) rmSync(repository, { recursive: true, force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    repository = undefined;
    scratch = undefined;
  });

  it("bootstraps a cold repository and reuses the first run's memory in the second run", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-daily-workflow-"));
    repository = createTestRepository("repomind-daily-repo-");
    const dataDirectory = join(scratch, "data");
    writeFileSync(join(repository, "README.md"), "# Ledger workflow\n\nLedger checkpoints are append-only repository snapshots.\n", "utf8");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "document ledger checkpoints");
    withDataDirectory(dataDirectory, () => initializeRepository(repository!).database.close());
    const bundle = withDataDirectory(dataDirectory, () => generateBootstrapBundle(repository!));
    const readme = bundle.candidates.find((entry) => entry.source.kind === "readme")!;
    withDataDirectory(dataDirectory, () => applyBootstrapBundle(repository!, bundle, [readme.id]));

    const firstSummary = "Implemented the ledger checkpoint convention with append-only snapshot files.";
    const first = await runOpenCodeHost({
      repository,
      task: "Implement the documented ledger checkpoint workflow",
      dataDirectory,
      outputDirectory: join(scratch, "first"),
      execute: successfulAgent(firstSummary, () => writeFileSync(join(repository!, "checkpoint.txt"), "append-only\n", "utf8")),
    });
    expect(first).toMatchObject({ succeeded: true, session: { status: "committed", retrievedMemories: 1 } });

    let secondPrompt = "";
    const secondExecute: OpenCodeProcessExecutor = async (request) => {
      secondPrompt = request.args.at(-1) ?? "";
      return successfulAgent("Reused the existing ledger checkpoint convention.")(request);
    };
    const second = await runOpenCodeHost({
      repository,
      task: "Reuse the ledger checkpoint convention for another snapshot",
      dataDirectory,
      outputDirectory: join(scratch, "second"),
      execute: secondExecute,
    });

    expect(second).toMatchObject({ succeeded: true, session: { status: "committed" } });
    expect(second.session.retrievedMemories).toBeGreaterThanOrEqual(2);
    expect(secondPrompt).toContain(firstSummary);
    withDataDirectory(dataDirectory, () => {
      const core = new RepositoryMemoryCore(repository!);
      expect(core.listHostRuns()).toEqual([
        expect.objectContaining({ id: second.runId, status: "committed" }),
        expect.objectContaining({ id: first.runId, status: "committed" }),
      ]);
      expect(core.listSessions().filter((entry) => (entry as { status: string }).status === "open")).toEqual([]);
      core.close();
    });
  });
});
