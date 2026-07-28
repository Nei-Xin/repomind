import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import {
  executeOpenCodeProcess,
  hostManagedOpenCodeConfig,
  runOpenCodeHost,
  type OpenCodeProcessExecutor,
  type OpenCodeProcessResult,
} from "../src/integrations/opencode/run.js";

function git(repository: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function createRepository(root: string): string {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet");
  git(repository, "config", "user.email", "test@example.com");
  git(repository, "config", "user.name", "RepoMind Test");
  writeFileSync(join(repository, "README.md"), "# Host run test\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "--quiet", "-m", "initial");
  initializeRepository(repository).database.close();
  git(repository, "add", ".repomind/project.json");
  git(repository, "commit", "--quiet", "-m", "initialize repomind");
  return repository;
}

function processResult(overrides: Partial<OpenCodeProcessResult> = {}): OpenCodeProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 10,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function withDataDirectory<T>(dataDirectory: string, action: () => T): T {
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

describe("daily OpenCode host runner", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("retrieves memory, runs without RepoMind MCP, commits evidence, and redacts artifacts", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-run-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const outputDirectory = join(scratch, "output");
    withDataDirectory(dataDirectory, () => {
      const seed = new RepositoryMemoryCore(repository);
      seed.record({
        type: "convention",
        title: "Invoice arithmetic",
        content: "Invoice totals multiply each price by its quantity.",
      });
      seed.close();
    });

    let request: Parameters<OpenCodeProcessExecutor>[0] | undefined;
    const execute: OpenCodeProcessExecutor = async (input) => {
      request = input;
      writeFileSync(join(repository, "result.txt"), "implemented\n", "utf8");
      const events = [
        { type: "step_finish", part: { tokens: { input: 20, output: 5, cache: { read: 10, write: 0 } } } },
        {
          type: "tool_use",
          part: {
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "npm test" },
              output: "tests passed; api_key=supersecret1234",
              metadata: { exit: 0 },
            },
          },
        },
        { type: "text", part: { text: "Implemented invoice totals; api_key=supersecret1234" } },
      ];
      return processResult({ stdout: `${events.map(JSON.stringify).join("\n")}\n` });
    };

    const report = await runOpenCodeHost({
      repository,
      task: "Fix invoice quantity arithmetic",
      dataDirectory,
      outputDirectory,
      runnerExecutable: "fake-opencode",
      model: "test/model",
      execute,
    });

    expect(report.succeeded).toBe(true);
    expect(report.session).toMatchObject({ status: "committed", retrievedMemories: 1 });
    expect(report.commit).toMatchObject({ status: "committed" });
    expect(report.agent.events).toMatchObject({ repoMindCalls: 0, turns: 1 });
    expect(report.summary).toContain("[REDACTED:credential]");
    expect(report.redactions.events).toBeGreaterThan(0);
    expect(report.redactions.report).toBeGreaterThan(0);
    expect(request?.args).toContain("--pure");
    expect(request?.args).toContain("test/model");
    expect(request?.args.at(-1)).toContain("Invoice arithmetic");
    const config = JSON.parse(request?.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: { repomind?: { enabled?: boolean } };
      agent?: Record<string, unknown>;
    };
    expect(config.mcp?.repomind?.enabled).toBe(false);
    expect(config.agent).toHaveProperty("repomind-host");

    const eventsArtifact = readFileSync(report.artifacts.events, "utf8");
    const reportArtifact = readFileSync(report.artifacts.report, "utf8");
    expect(eventsArtifact).not.toContain("supersecret1234");
    expect(reportArtifact).not.toContain("supersecret1234");
    expect(eventsArtifact).toContain("[REDACTED:credential]");
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([
        expect.objectContaining({ id: report.session.id, status: "committed", client_name: "opencode-host" }),
      ]);
      verify.close();
    });
  });

  it("commits a normal nonzero exit as failed and propagates the Agent result", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-failed-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const report = await runOpenCodeHost({
      repository,
      task: "Attempt a failing change",
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({
        exitCode: 2,
        stdout: `${JSON.stringify({ type: "text", part: { text: "The task failed." } })}\n`,
      }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.agent.exitCode).toBe(2);
    expect(report.session.status).toBe("failed");
    expect(report.commit?.status).toBe("failed");
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "failed" })]);
      verify.close();
    });
  });

  it("abandons an interrupted run instead of leaving an open session", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-aborted-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const report = await runOpenCodeHost({
      repository,
      task: "Run until interrupted",
      dataDirectory,
      execute: async () => processResult({ exitCode: null, signal: "SIGTERM", timedOut: true }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.session.status).toBe("abandoned");
    expect(report.session.abandonMs).not.toBeNull();
    expect(report.commit).toBeNull();
    expect(report.outputDirectory.startsWith(join(dataDirectory, "runs"))).toBe(true);
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      verify.close();
    });
  });

  it("does not accept an Agent-side RepoMind call as a successful host lifecycle", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-violation-"));
    const repository = createRepository(scratch);
    const report = await runOpenCodeHost({
      repository,
      task: "Do not call RepoMind from the Agent",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({
        stdout: `${JSON.stringify({
          type: "tool_use",
          part: { tool: "repomind_repo_memory_search", state: { status: "completed" } },
        })}\n${JSON.stringify({ type: "text", part: { text: "Done." } })}\n`,
      }),
    });

    expect(report.agent.events.repoMindCalls).toBe(1);
    expect(report.succeeded).toBe(false);
    expect(report.session.status).toBe("partial");
    expect(report.commit?.status).toBe("partial");
  });

  it("abandons the session when artifact setup fails before Agent execution", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-output-failure-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const outputDirectory = join(scratch, "occupied-output");
    mkdirSync(outputDirectory);
    writeFileSync(join(outputDirectory, "existing.txt"), "do not overwrite\n", "utf8");

    await expect(runOpenCodeHost({
      repository,
      task: "Do not overwrite existing artifacts",
      dataDirectory,
      outputDirectory,
      execute: async () => processResult(),
    })).rejects.toThrow("Run output directory is not empty");

    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      verify.close();
    });
  });

  it("abandons sessions when initial or hybrid retrieval throws", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-retrieval-failure-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    await withDataDirectory(dataDirectory, async () => {
      const initial = new RepositoryMemoryCore(repository);
      vi.spyOn(initial, "search").mockImplementation(() => { throw new Error("initial retrieval failed"); });
      expect(() => initial.startSession({ task: "Initial failure" })).toThrow("initial retrieval failed");
      expect(initial.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      initial.close();

      const hybrid = new RepositoryMemoryCore(repository);
      vi.spyOn(hybrid, "searchHybrid").mockRejectedValue(new Error("hybrid retrieval failed"));
      await expect(hybrid.startSessionHybrid({ task: "Hybrid failure" })).rejects.toThrow("hybrid retrieval failed");
      expect(hybrid.listSessions()).toEqual([
        expect.objectContaining({ task: "Hybrid failure", status: "abandoned" }),
        expect.objectContaining({ task: "Initial failure", status: "abandoned" }),
      ]);
      hybrid.close();
    });
  });

  it("preserves existing OpenCode content while disabling RepoMind MCP", () => {
    const config = JSON.parse(hostManagedOpenCodeConfig(JSON.stringify({
      model: "provider/model",
      mcp: { other: { type: "remote", url: "https://example.test" } },
    }))) as { model: string; mcp: Record<string, { enabled?: boolean }>; agent: Record<string, unknown> };
    expect(config.model).toBe("provider/model");
    expect(config.mcp).toHaveProperty("other");
    expect(config.mcp.repomind?.enabled).toBe(false);
    expect(config.agent).toHaveProperty("repomind-host");
  });

  it("terminates a timed-out child process", async () => {
    const result = await executeOpenCodeProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
