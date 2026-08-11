import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { startHostLifecycle } from "../src/integrations/opencode/lifecycle.js";
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
  const result = {
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
  if (
    result.exitCode === 0
    && !result.stdout.includes('"type":"error"')
  ) {
    result.stdout = `${result.stdout}${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`;
  }
  return result;
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
    const seededLayers = withDataDirectory(dataDirectory, () => {
      const seed = new RepositoryMemoryCore(repository);
      seed.record({
        type: "convention",
        title: "Invoice arithmetic",
        content: "Invoice totals multiply each price by its quantity.",
        scopeType: "module",
        scopeValue: "src/billing",
      });
      const moduleNarrative = seed.rebuildModuleNarratives().narratives[0]!;
      const repositoryProfile = seed.rebuildRepositoryProfile().profile;
      seed.close();
      return { moduleNarrative, repositoryProfile };
    });

    let request: Parameters<OpenCodeProcessExecutor>[0] | undefined;
    const execute: OpenCodeProcessExecutor = async (input) => {
      request = input;
      writeFileSync(join(repository, "result.txt"), "implemented\n", "utf8");
      const events = [
        { type: "step_finish", part: { reason: "stop", tokens: { input: 20, output: 5, cache: { read: 10, write: 0 } } } },
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
    expect(report.version).toBe(3);
    expect(report.quality).toMatchObject({
      completion: "clean", status: "success", maintenanceEligible: true,
      commands: { observed: 1, failed: 0, recovered: 0, unrecovered: 0 },
      authoritativeVerification: { authority: "none", checks: 0, passed: null, snapshotStable: null },
    });
    expect(report.session).toMatchObject({
      status: "committed",
      retrievedMemories: 1,
      retrievedMemoryIds: [expect.stringMatching(/^mem_/)],
      retrievedModuleNarratives: 1,
      retrievedModuleNarrativeIds: [seededLayers.moduleNarrative.id],
      retrievedModuleNarrativeVersions: [{ id: seededLayers.moduleNarrative.id, version: 1 }],
      repositoryProfileId: seededLayers.repositoryProfile.id,
      repositoryProfileVersion: 1,
      maintenanceMs: expect.any(Number),
    });
    expect(report.context).toMatchObject({
      budgetChars: 12_000,
      l1: { injected: 1 },
      l2: { eligible: 1, injected: 0, deduplicated: 1, deduplicatedIds: [seededLayers.moduleNarrative.id] },
      l3: { eligible: 1, injected: 0, deduplicated: 1, deduplicatedIds: [seededLayers.repositoryProfile.id] },
      currentTask: { truncated: false },
    });
    expect(report.context.contextChars).toBeLessThanOrEqual(report.context.budgetChars);
    expect(report.commit).toMatchObject({ status: "committed" });
    expect(report.maintenance).toMatchObject({
      status: "success",
      l2: { status: "success" },
      l3: { status: "success" },
      l4: { status: "skipped" },
    });
    expect(report.agent.events).toMatchObject({ repoMindCalls: 0, turns: 1 });
    expect(report.summary).toContain("[REDACTED:credential]");
    expect(report.redactions.events).toBeGreaterThan(0);
    expect(report.redactions.report).toBeGreaterThan(0);
    expect(request?.args).toContain("--pure");
    expect(request?.args).toContain("test/model");
    expect(request?.args.at(-1)).toContain("Invoice arithmetic");
    expect(request?.args.at(-1)).toContain("## Repository Profile (L3)");
    expect(request?.args.at(-1)).toContain("## Relevant Modules (L2)");
    expect(request?.args.at(-1)).toContain("## Task Memories (L1)");
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
      expect(verify.listHostRuns()).toEqual([
        expect.objectContaining({
          id: report.runId,
          sessionId: report.session.id,
          status: "committed",
          retrievedMemories: 1,
          agentExitCode: 0,
          repoMindCalls: 0,
          reportPath: report.artifacts.report,
        }),
      ]);
      expect(verify.inspectHostRun(report.runId)).toMatchObject({
        model: "test/model",
        inputTokens: 20,
        outputTokens: 5,
        metadata: {
          retrievedMemoryIds: report.session.retrievedMemoryIds,
          retrievedModuleNarrativeIds: report.session.retrievedModuleNarrativeIds,
          retrievedModuleNarrativeVersions: report.session.retrievedModuleNarrativeVersions,
          repositoryProfileId: report.session.repositoryProfileId,
          repositoryProfileVersion: report.session.repositoryProfileVersion,
          context: {
            budgetChars: 12_000,
            l1: { injected: 1 },
            l2: { eligible: 1, injected: 0, deduplicated: 1 },
            l3: { eligible: 1, injected: 0, deduplicated: 1 },
          },
          maintenance: { status: "success" },
        },
      });
      expect(verify.listModuleNarratives().length).toBeGreaterThan(0);
      expect(verify.getRepositoryProfile()).toMatchObject({ current: true });
      verify.close();
    });
  });

  it("retries the real OpenCode certificate-error event before Host verification or commit", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-opencode-cert-retry-"));
    const repository = createRepository(scratch);
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) {
        return processResult({
          exitCode: 1,
          stdout: `${JSON.stringify({
            type: "error",
            error: { name: "UnknownError", data: { message: "unknown certificate verification error" } },
          })}\n`,
        });
      }
      return processResult({
        stdout: `${JSON.stringify({ type: "text", part: { text: "Recovered and completed." } })}\n`,
      });
    });
    const verify = vi.fn(() => [{ command: "node --test", exitCode: 0, summary: "passed" }]);

    const report = await runOpenCodeHost({
      repository,
      task: "Recover an OpenCode infrastructure launch failure",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute,
      retryDelayMs: 0,
      verify,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(report.retry).toMatchObject({ attempts: 2, retries: 1, exhausted: false });
    expect(report.attempts[0]).toMatchObject({
      retry: { eligible: true, matchedSignals: ["tls-certificate"], scheduled: true },
    });
    expect(report.succeeded).toBe(true);
    expect(report.session.status).toBe("committed");
  });

  it("resumes the same OpenCode session after an upstream response stream interruption", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-opencode-stream-resume-"));
    const repository = createRepository(scratch);
    const requests: Array<Parameters<OpenCodeProcessExecutor>[0]> = [];
    const statuses: string[] = [];
    const execute: OpenCodeProcessExecutor = async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        writeFileSync(join(repository, "result.txt"), "implemented before interruption\n", "utf8");
        const events = [
          {
            type: "step_finish",
            sessionID: "ses_opencode_resume",
            part: { reason: "tool-calls", tokens: { input: 6, output: 2, reasoning: 1, cache: { read: 1, write: 0 } } },
          },
          {
            type: "tool_use",
            sessionID: "ses_opencode_resume",
            part: { tool: "apply_patch", state: { status: "completed", input: {}, output: "patched" } },
          },
          {
            type: "error",
            sessionID: "ses_opencode_resume",
            error: {
              name: "UnknownError",
              data: { message: JSON.stringify({
                message: "Upstream response stream was interrupted",
                type: "upstream_error",
                code: "upstream_stream_read_error",
              }) },
            },
          },
        ];
        return processResult({ exitCode: 1, stdout: `${events.map(JSON.stringify).join("\n")}\n` });
      }
      return processResult({
        stdout: `${[
          { type: "text", sessionID: "ses_opencode_resume", part: { text: "Verified and completed." } },
          {
            type: "step_finish",
            sessionID: "ses_opencode_resume",
            part: { reason: "stop", tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 2, write: 0 } } },
          },
        ].map(JSON.stringify).join("\n")}\n`,
      });
    };
    const verify = vi.fn(() => [{ command: "node --test", exitCode: 0, summary: "passed" }]);

    const report = await runOpenCodeHost({
      repository,
      task: "Finish a task after an upstream stream interruption",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute,
      retryDelayMs: 0,
      verify,
      onStatus: (status) => { statuses.push(status); },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.args).not.toContain("--session");
    const sessionFlag = requests[1]!.args.indexOf("--session");
    expect(sessionFlag).toBeGreaterThanOrEqual(0);
    expect(requests[1]!.args[sessionFlag + 1]).toBe("ses_opencode_resume");
    expect(requests[1]!.args.at(-1)).toContain("Continue the interrupted task");
    expect(requests[1]!.args.at(-1)).not.toBe(requests[0]!.args.at(-1));
    expect(statuses.some((status) => status.includes("resuming the existing provider session"))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(report.succeeded).toBe(true);
    expect(report.attempts.map((attempt) => attempt.executionMode)).toEqual(["fresh", "resume"]);
    expect(report.attempts[0]).toMatchObject({
      retry: {
        eligible: true,
        mode: "resume",
        matchedSignals: ["upstream-http2-stream"],
        scheduled: true,
        conditions: {
          resumeSupported: true,
          resumeTokenAvailable: true,
          noCommandActivity: true,
          noRepoMindActivity: true,
          resumeSafeTools: true,
        },
      },
    });
    expect(report.agent.events).toMatchObject({
      turns: 2,
      tokens: { input: 10, output: 3, reasoning: 1, cacheRead: 3, cacheWrite: 0 },
      toolCalls: { apply_patch: 1 },
    });
  });

  it("keeps a successful Host run committed when unexpected derived maintenance fails", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-maintenance-failure-"));
    const repository = createRepository(scratch);
    const maintenance = vi.spyOn(RepositoryMemoryCore.prototype, "maintainDerivedLayers")
      .mockImplementationOnce(() => { throw new Error("Injected unexpected maintenance failure"); });
    try {
      const report = await runOpenCodeHost({
        repository,
        task: "Complete a successful task despite maintenance failure",
        dataDirectory: join(scratch, "data"),
        outputDirectory: join(scratch, "output"),
        execute: async () => processResult({
          stdout: `${JSON.stringify({ type: "text", part: { text: "Task completed successfully." } })}\n`,
        }),
      });

      expect(report.succeeded).toBe(true);
      expect(report.session.status).toBe("committed");
      expect(report.commit?.status).toBe("committed");
      expect(report.maintenance).toMatchObject({
        status: "failed",
        l2: { status: "failed", error: { code: "INTERNAL_ERROR", message: "Injected unexpected maintenance failure" } },
        l3: { status: "failed" },
        l4: { status: "failed" },
      });
    } finally {
      maintenance.mockRestore();
    }
  });

  it("isolates data directories across concurrent Host lifecycle starts", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-concurrent-data-"));
    const rootA = join(scratch, "a");
    const rootB = join(scratch, "b");
    mkdirSync(rootA);
    mkdirSync(rootB);
    const repositoryA = createRepository(rootA);
    const repositoryB = createRepository(rootB);
    const dataA = join(scratch, "data-a");
    const dataB = join(scratch, "data-b");
    const previous = process.env.REPOMIND_DATA_DIR;
    delete process.env.REPOMIND_DATA_DIR;
    try {
      const [startedA, startedB] = await Promise.all([
        startHostLifecycle(repositoryA, "Concurrent task A", dataA),
        startHostLifecycle(repositoryB, "Concurrent task B", dataB),
      ]);
      expect(process.env.REPOMIND_DATA_DIR).toBeUndefined();

      const coreA = new RepositoryMemoryCore(repositoryA, { dataDirectory: dataA });
      const coreB = new RepositoryMemoryCore(repositoryB, { dataDirectory: dataB });
      try {
        expect(coreA.listSessions()).toEqual([expect.objectContaining({ id: startedA.sessionId, task: "Concurrent task A" })]);
        expect(coreB.listSessions()).toEqual([expect.objectContaining({ id: startedB.sessionId, task: "Concurrent task B" })]);
        coreA.abandonSession(startedA.sessionId);
        coreB.abandonSession(startedB.sessionId);
      } finally {
        coreA.close();
        coreB.close();
      }
    } finally {
      if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
      else process.env.REPOMIND_DATA_DIR = previous;
    }
  });

  it("injects zero L1 records at maxMemories zero while preserving L2 and L3", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-zero-l1-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const seededLayers = withDataDirectory(dataDirectory, () => {
      const seed = new RepositoryMemoryCore(repository);
      seed.record({
        type: "convention",
        title: "Release workflow ownership",
        content: "The release module owns the verified release workflow.",
        confidence: 0.95,
        scopeType: "module",
        scopeValue: "src/release",
      });
      const moduleNarrative = seed.rebuildModuleNarratives().narratives[0]!;
      const repositoryProfile = seed.rebuildRepositoryProfile().profile;
      seed.close();
      return { moduleNarrative, repositoryProfile };
    });
    let prompt = "";

    const report = await runOpenCodeHost({
      repository,
      task: "Run the release workflow",
      maxMemories: 0,
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute: async (request) => {
        prompt = request.args.at(-1) ?? "";
        return processResult({
          stdout: `${JSON.stringify({ type: "text", part: { text: "Release workflow completed." } })}\n`,
        });
      },
    });

    expect(report.succeeded).toBe(true);
    expect(report.session).toMatchObject({
      status: "committed",
      retrievedMemories: 0,
      retrievedMemoryIds: [],
      retrievedModuleNarratives: 1,
      retrievedModuleNarrativeIds: [seededLayers.moduleNarrative.id],
      repositoryProfileId: seededLayers.repositoryProfile.id,
    });
    expect(report.context).toMatchObject({
      l1: { provided: 0, eligible: 0, injected: 0, injectedIds: [] },
      l2: { injected: 1, injectedIds: [seededLayers.moduleNarrative.id] },
      l3: { injected: 1, injectedIds: [seededLayers.repositoryProfile.id] },
    });
    expect(prompt).toContain("No matching task memories were retrieved.");
    expect(prompt).toContain("## Relevant Modules (L2)");
    expect(prompt).toContain("## Repository Profile (L3)");
  });

  it("commits a failed non-test command as partial without derived maintenance", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-failed-command-"));
    const repository = createRepository(scratch);
    const maintenance = vi.spyOn(RepositoryMemoryCore.prototype, "maintainDerivedLayers");
    try {
      const events = [
        {
          type: "tool_use",
          part: {
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "npm run build" },
              output: "build failed",
              metadata: { exit: 1 },
            },
          },
        },
        { type: "text", part: { text: "The build still fails." } },
      ];
      const report = await runOpenCodeHost({
        repository,
        task: "Build the project",
        dataDirectory: join(scratch, "data"),
        outputDirectory: join(scratch, "output"),
        execute: async () => processResult({ stdout: `${events.map(JSON.stringify).join("\n")}\n` }),
      });

      expect(report.agent).toMatchObject({ exitCode: 0, events: { failedCommands: 1 } });
      expect(report.succeeded).toBe(false);
      expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
      expect(report.commit).toMatchObject({ status: "partial" });
      expect(report.maintenance).toBeNull();
      expect(maintenance).not.toHaveBeenCalled();
    } finally {
      maintenance.mockRestore();
    }
  });

  it("commits and maintains a recovered run only after Host-owned verification passes", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-recovered-command-"));
    const repository = createRepository(scratch);
    const events = [
      { type: "tool_use", part: { tool: "bash", state: {
        status: "completed", input: { command: "node --input-type=module -e \"broken probe\"" },
        output: "probe failed", metadata: { exit: 1 },
      } } },
      { type: "tool_use", part: { tool: "bash", state: {
        status: "completed", input: { command: "node --input-type=module -e \"corrected probe\"" },
        output: "probe passed", metadata: { exit: 0 },
      } } },
      { type: "text", part: { text: "The corrected implementation is verified." } },
    ];
    const report = await runOpenCodeHost({
      repository,
      task: "Recover a failed exploratory probe",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({ stdout: `${events.map(JSON.stringify).join("\n")}\n` }),
      verify: () => [{ command: "node --test", exitCode: 0, summary: "authoritative tests passed" }],
    });

    expect(report.succeeded).toBe(true);
    expect(report.session.status).toBe("committed");
    expect(report.quality).toMatchObject({
      completion: "recovered",
      status: "success",
      maintenanceEligible: true,
      qualityFlags: ["recovered-command-failure"],
      commands: { observed: 2, failed: 1, recovered: 1, unrecovered: 0 },
      authoritativeVerification: { authority: "host-config", checks: 1, passed: true, snapshotStable: true },
    });
    expect(report.maintenance).not.toBeNull();
    expect(JSON.parse(readFileSync(report.artifacts.report, "utf8"))).toMatchObject({
      quality: { qualityFlags: ["recovered-command-failure"] },
      context: { promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
  });

  it("commits malformed Agent JSONL as partial without derived maintenance", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-malformed-events-"));
    const repository = createRepository(scratch);
    const report = await runOpenCodeHost({
      repository,
      task: "Reject malformed Agent events",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({ stdout: "this is not JSON\n" }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
    expect(report.commit).toMatchObject({ status: "partial" });
    expect(report.quality).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["malformed-agent-events"],
      trace: { malformedLines: 1, explicitErrors: 0, terminal: "clean-stop" },
    });
    expect(report.maintenance).toBeNull();
  });

  it("retains passing verification Evidence without promoting L1 for a partial session", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-partial-evidence-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const report = await runOpenCodeHost({
      repository,
      task: "Preserve partial-session verification evidence",
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({ stdout: "this is not JSON\n" }),
      verify: () => [{ command: "node --test", exitCode: 0, summary: "public tests passed" }],
    });

    expect(report.succeeded).toBe(false);
    expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
    expect(report.commit).toMatchObject({
      status: "partial",
      evidenceCreated: 3,
      memories: { stored: 0, skipped: 0, conflicts: 0 },
    });
    expect(report.maintenance).toBeNull();
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.status()).toMatchObject({ sessions: 1, evidence: 5, memories: 0 });
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "partial" })]);
      verify.close();
    });
  });

  it("commits an explicit Agent error as partial without derived maintenance", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-explicit-error-"));
    const repository = createRepository(scratch);
    const report = await runOpenCodeHost({
      repository,
      task: "Reject an explicit Agent error",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({
        stdout: `${JSON.stringify({ type: "error", error: { message: "Agent failed internally" } })}\n`,
      }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
    expect(report.commit).toMatchObject({ status: "partial" });
    expect(report.quality).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["explicit-agent-error"],
      trace: { malformedLines: 0, explicitErrors: 1, terminal: "explicit-error" },
    });
    expect(report.maintenance).toBeNull();
  });

  it("commits a shell command with an unknown exit result as partial without derived maintenance", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-unknown-command-result-"));
    const repository = createRepository(scratch);
    const event = {
      type: "tool_use",
      part: {
        tool: "shell",
        state: {
          status: "completed",
          input: { command: "npm test" },
          output: "command output without exit metadata",
          metadata: {},
        },
      },
    };
    const report = await runOpenCodeHost({
      repository,
      task: "Reject unknown shell command results",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({ stdout: `${JSON.stringify(event)}\n` }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
    expect(report.commit).toMatchObject({ status: "partial" });
    expect(report.quality).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["unrecovered-command-failure", "unknown-command-result"],
      commands: { observed: 1, failed: 1, recovered: 0, unrecovered: 1 },
      trace: { unknownCommandResults: 1, terminal: "clean-stop" },
    });
    expect(report.maintenance).toBeNull();
  });

  it("does not recover a failed command when Host verification changes the Git snapshot", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-verification-mutated-"));
    const repository = createRepository(scratch);
    const event = {
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test" },
          output: "tests failed before Host verification",
          metadata: { exit: 1 },
        },
      },
    };
    const report = await runOpenCodeHost({
      repository,
      task: "Do not trust a mutating verification callback",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult({ stdout: `${JSON.stringify(event)}\n` }),
      verify: () => {
        writeFileSync(join(repository, "verification-side-effect.txt"), "mutated during verification\n", "utf8");
        return [{ command: "npm test", exitCode: 0, summary: "verification reported success" }];
      },
    });

    expect(report.succeeded).toBe(false);
    expect(report.session).toMatchObject({ status: "partial", maintenanceMs: null });
    expect(report.commit).toMatchObject({ status: "partial" });
    expect(report.quality).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["unrecovered-command-failure", "verification-snapshot-changed"],
      commands: { observed: 1, failed: 1, recovered: 0, unrecovered: 1 },
      authoritativeVerification: { authority: "host-config", checks: 1, passed: true, snapshotStable: false },
    });
    expect(report.maintenance).toBeNull();
  });

  it("commits a failed authoritative verification as failed without derived maintenance", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-verification-failed-"));
    const repository = createRepository(scratch);
    const execute = vi.fn(async () => processResult());
    const report = await runOpenCodeHost({
      repository,
      task: "Require authoritative verification to pass",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      execute,
      verify: () => [{ command: "npm test", exitCode: 1, summary: "authoritative tests failed" }],
    });

    expect(report.succeeded).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.retry).toMatchObject({ attempts: 1, retries: 0 });
    expect(report.session).toMatchObject({ status: "failed", maintenanceMs: null });
    expect(report.commit).toMatchObject({ status: "failed" });
    expect(report.quality).toMatchObject({
      completion: "failed",
      status: "failed",
      maintenanceEligible: false,
      qualityFlags: ["authoritative-verification-failed"],
      commands: { observed: 0, failed: 0, recovered: 0, unrecovered: 0 },
      authoritativeVerification: { authority: "host-config", checks: 1, passed: false, snapshotStable: true },
    });
    expect(report.maintenance).toBeNull();
  });

  it("retains passing public Evidence without promoting L1 when hidden verification fails", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-failed-evidence-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const publicCheck = { command: "node --test", exitCode: 0, summary: "public tests passed" };
    const hiddenCheck = { command: "hidden verification", exitCode: 1, summary: "hidden verification failed" };
    const report = await runOpenCodeHost({
      repository,
      task: "Preserve public evidence from a failed task",
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult(),
      verify: () => ({ checks: [publicCheck, hiddenCheck], evidence: [publicCheck] }),
    });

    expect(report.succeeded).toBe(false);
    expect(report.quality).toMatchObject({
      status: "failed",
      qualityFlags: ["authoritative-verification-failed"],
      authoritativeVerification: { checks: 2, passed: false },
    });
    expect(report.session).toMatchObject({ status: "failed", maintenanceMs: null });
    expect(report.commit).toMatchObject({
      status: "failed",
      evidenceCreated: 3,
      memories: { stored: 0, skipped: 0, conflicts: 0 },
    });
    expect(report.maintenance).toBeNull();
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.status()).toMatchObject({ sessions: 1, evidence: 5, memories: 0 });
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "failed" })]);
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
    expect(report.maintenance).toBeNull();
    expect(report.session.maintenanceMs).toBeNull();
    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "failed" })]);
      expect(verify.listHostRuns({ status: "failed" })).toEqual([expect.objectContaining({ id: report.runId, agentExitCode: 2 })]);
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
      expect(verify.listHostRuns({ status: "abandoned" })).toEqual([expect.objectContaining({ id: report.runId, status: "abandoned" })]);
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
      expect(verify.listHostRuns()).toEqual([expect.objectContaining({ status: "abandoned", error: expect.stringContaining("not empty") })]);
      verify.close();
    });
  });

  it("abandons the session when layered context rendering fails before Host-run registration", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-context-failure-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const originalStart = RepositoryMemoryCore.prototype.startSessionHybrid;
    const retrieval = vi.spyOn(RepositoryMemoryCore.prototype, "startSessionHybrid")
      .mockImplementation(async function (input) {
        const result = await originalStart.call(this, input);
        return {
          ...result,
          moduleNarratives: [{
            id: "l2_invalid",
            modulePath: null as unknown as string,
            title: "Invalid narrative",
            content: "Invalid narrative content",
            sourceCount: 1,
            sourceMemoryIds: [],
            budgetChars: 500,
            version: 1,
            current: true,
            createdAt: 1,
            updatedAt: 1,
          }],
        };
      });
    try {
      await expect(runOpenCodeHost({
        repository,
        task: "Exercise context cleanup",
        dataDirectory,
        outputDirectory: join(scratch, "output"),
        execute: async () => processResult(),
      })).rejects.toThrow();
    } finally {
      retrieval.mockRestore();
    }

    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      expect(verify.listHostRuns()).toEqual([]);
      verify.close();
    });
  });

  it.runIf(process.platform === "win32")("rejects an oversized Windows argv prompt and abandons its session", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-windows-prompt-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");

    await expect(runOpenCodeHost({
      repository,
      task: `Oversized task ${"x".repeat(30_000)}`,
      contextBudgetChars: 1_000,
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute: async () => processResult(),
    })).rejects.toThrow(/too large for a reliable Windows process launch/u);

    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      expect(verify.listHostRuns()).toEqual([]);
      verify.close();
    });
  });

  it.runIf(process.platform === "win32")("accounts for Windows argv quote expansion before spawning OpenCode", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-windows-quoting-"));
    const repository = createRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const execute = vi.fn(async () => processResult());

    await expect(runOpenCodeHost({
      repository,
      task: `Quoted task ${"\"".repeat(17_000)}`,
      contextBudgetChars: 1_000,
      dataDirectory,
      outputDirectory: join(scratch, "output"),
      execute,
    })).rejects.toThrow(/quoted command-line characters/u);
    expect(execute).not.toHaveBeenCalled();

    withDataDirectory(dataDirectory, () => {
      const verify = new RepositoryMemoryCore(repository);
      expect(verify.listSessions()).toEqual([expect.objectContaining({ status: "abandoned" })]);
      expect(verify.listHostRuns()).toEqual([]);
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
    }))) as {
      model: string;
      mcp: Record<string, { enabled?: boolean }>;
      agent: Record<string, { permission?: Record<string, string> }>;
    };
    expect(config.model).toBe("provider/model");
    expect(config.mcp).toHaveProperty("other");
    expect(config.mcp.repomind?.enabled).toBe(false);
    expect(config.agent).toHaveProperty("repomind-host");
    expect(config.agent["repomind-host"]?.permission?.external_directory).toBe("deny");
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
