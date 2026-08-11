import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRepository } from "../src/repository.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import { assessAgentInfrastructureRetry } from "../src/integrations/agent-host/retry.js";
import type {
  AgentHostAdapter,
  AgentHostRunResult,
  AgentOutcome,
} from "../src/integrations/agent-host/types.js";
import { git } from "./helpers.js";

function createRepository(root: string): string {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet");
  git(repository, "config", "user.email", "test@example.com");
  git(repository, "config", "user.name", "RepoMind Test");
  writeFileSync(join(repository, "README.md"), "# Generic host test\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "--quiet", "-m", "initial");
  initializeRepository(repository).database.close();
  git(repository, "add", ".repomind/project.json");
  git(repository, "commit", "--quiet", "-m", "initialize repomind");
  return repository;
}

function fixtureAdapter(outcome: AgentOutcome): AgentHostAdapter<"fixture"> {
  const result: AgentHostRunResult = {
    process: {
      exitCode: 0,
      signal: null,
      stdout: "fixture event stream\n",
      stderr: "",
      durationMs: 5,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    outcome,
    events: {
      turns: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: {},
      failedTools: 0,
      failedCommands: outcome.commands.filter((command) => command.exitCode !== 0).length,
      fileReads: 0,
      failedFileReads: 0,
      repeatedFileReads: 0,
      repoMindCalls: 0,
      retrievedMemories: 0,
    },
  };
  return {
    id: "fixture",
    displayName: "Fixture Agent",
    executable: "fixture-agent",
    validate: () => undefined,
    run: async () => result,
    version: async () => "fixture-agent 1.0",
  };
}

function failedCommandOutcome(): AgentOutcome {
  return {
    summary: "A failed probe was corrected before the final handoff.",
    commands: [{
      command: "fixture probe",
      exitCode: 1,
      exitCodeKnown: true,
      isTest: false,
      summary: "probe failed",
    }],
    trace: {
      parsedEvents: 2,
      malformedLines: 0,
      explicitErrors: 0,
      unknownCommandResults: 0,
      terminal: "clean-stop",
    },
  };
}

function cleanResult(): AgentHostRunResult {
  return {
    process: {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`,
      stderr: "",
      durationMs: 7,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    outcome: {
      summary: "Completed after infrastructure recovered.",
      commands: [],
      trace: {
        parsedEvents: 1,
        malformedLines: 0,
        explicitErrors: 0,
        unknownCommandResults: 0,
        terminal: "clean-stop",
      },
    },
    events: {
      turns: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: {},
      failedTools: 0,
      failedCommands: 0,
      fileReads: 0,
      failedFileReads: 0,
      repeatedFileReads: 0,
      repoMindCalls: 0,
      retrievedMemories: 0,
    },
  };
}

function transientFailureResult(
  overrides: {
    process?: Partial<AgentHostRunResult["process"]>;
    outcome?: Partial<AgentHostRunResult["outcome"]>;
    events?: Partial<AgentHostRunResult["events"]>;
  } = {},
): AgentHostRunResult {
  const message = "unknown certificate verification error; api_key=supersecret1234";
  const clean = cleanResult();
  return {
    process: {
      ...clean.process,
      exitCode: 1,
      stdout: `${JSON.stringify({ type: "error", error: { message } })}\n`,
      durationMs: 5,
      ...overrides.process,
    },
    outcome: {
      summary: `Agent failed: ${message}`,
      commands: [],
      trace: {
        parsedEvents: 1,
        malformedLines: 0,
        explicitErrors: 1,
        unknownCommandResults: 0,
        terminal: "explicit-error",
      },
      ...overrides.outcome,
    },
    events: {
      ...clean.events,
      turns: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      ...overrides.events,
    },
  };
}

function sequenceAdapter(results: readonly AgentHostRunResult[]): {
  adapter: AgentHostAdapter<"fixture">;
  run: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const run = vi.fn(async () => results[Math.min(index++, results.length - 1)]!);
  return {
    adapter: {
      id: "fixture",
      displayName: "Fixture Agent",
      executable: "fixture-agent",
      validate: () => undefined,
      run,
      version: async () => "fixture-agent 1.0",
    },
    run,
  };
}

describe("generic Agent host runner", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("applies the shared partial gate to adapter-normalized command evidence", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-partial-"));
    const repository = createRepository(scratch);
    const report = await runAgentHost({
      adapter: fixtureAdapter(failedCommandOutcome()),
      repository,
      task: "Exercise the generic partial gate",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
    });

    expect(report.runner).toBe("fixture");
    expect(report.succeeded).toBe(false);
    expect(report.session.status).toBe("partial");
    expect(report.quality).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      commands: { failed: 1, recovered: 0, unrecovered: 1 },
    });
    expect(report.maintenance).toBeNull();
  });

  it("uses Host verification to recover adapter-normalized command evidence", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-recovered-"));
    const repository = createRepository(scratch);
    const report = await runAgentHost({
      adapter: fixtureAdapter(failedCommandOutcome()),
      repository,
      task: "Exercise generic Host recovery",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      verify: () => [{ command: "fixture verify", exitCode: 0, summary: "verification passed" }],
    });

    expect(report.succeeded).toBe(true);
    expect(report.session.status).toBe("committed");
    expect(report.quality).toMatchObject({
      completion: "recovered",
      status: "success",
      maintenanceEligible: true,
      commands: { failed: 1, recovered: 1, unrecovered: 0 },
      authoritativeVerification: { passed: true, snapshotStable: true },
    });
    expect(report.maintenance).not.toBeNull();
  });

  it.each([
    ["tls-certificate", "unknown certificate verification error", "stdout"],
    ["connection-reset", "read ECONNRESET", "stderr"],
    ["network-timeout", "upstream request timed out", "summary"],
    ["http-429", "HTTP 429 Too Many Requests", "stdout"],
    ["http-5xx", "status_code: 503", "stderr"],
    ["upstream-http2-stream", "upstream_http2_stream_error", "stdout"],
    ["upstream-http2-stream", "Upstream HTTP/2 stream failed", "summary"],
    ["upstream-http2-stream", "upstream_stream_read_error", "stdout"],
    ["upstream-http2-stream", "Upstream response stream was interrupted", "summary"],
  ] as const)("classifies the explicit %s infrastructure signal", (signal, diagnostic, source) => {
    const processOverrides = {
      stdout: source === "stdout" ? diagnostic : "",
      stderr: source === "stderr" ? diagnostic : "",
    };
    const execution = transientFailureResult({
      process: processOverrides,
      outcome: { summary: source === "summary" ? diagnostic : "Agent infrastructure failed." },
    });
    const snapshot = { branch: "main", head: "abc", dirty: false, status: "" };

    expect(assessAgentInfrastructureRetry({
      execution,
      snapshotBefore: snapshot,
      snapshotAfter: snapshot,
    })).toMatchObject({
      eligible: true,
      matchedSignals: [signal],
      blockers: [],
    });
  });

  it("retries an untouched zero-activity certificate failure before verification and commit", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-retry-"));
    const repository = createRepository(scratch);
    const fixture = sequenceAdapter([transientFailureResult(), cleanResult()]);
    const waits: number[] = [];
    const verify = vi.fn(() => [{ command: "fixture verify", exitCode: 0, summary: "passed" }]);
    const report = await runAgentHost({
      adapter: fixture.adapter,
      repository,
      task: "Retry a transient infrastructure launch failure",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 17,
      retryWait: (delayMs) => { waits.push(delayMs); },
      verify,
    });

    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([17]);
    expect(report.session.status).toBe("committed");
    expect(report.succeeded).toBe(true);
    expect(report.retry).toEqual({
      maxAttempts: 3,
      delayMs: 17,
      attempts: 2,
      retries: 1,
      exhausted: false,
    });
    expect(report.agent.durationMs).toBe(29);
    expect(report.attempts[0]).toMatchObject({
      attempt: 1,
      git: { unchanged: true },
      process: { exitCode: 1, timedOut: false, aborted: false },
      events: { tokens: { input: 0, output: 0 }, toolCalls: {}, repoMindCalls: 0 },
      outcome: { commands: [], trace: { terminal: "explicit-error" } },
      retry: {
        eligible: true,
        matchedSignals: ["tls-certificate"],
        scheduled: true,
        delayMs: 17,
        blockers: [],
      },
    });
    expect(report.attempts[1]).toMatchObject({
      attempt: 2,
      retry: { eligible: false, scheduled: false, delayMs: null },
    });
    const firstStdout = readFileSync(report.attempts[0]!.artifacts.stdout, "utf8");
    expect(firstStdout).toContain("unknown certificate verification error");
    expect(firstStdout).toContain("[REDACTED:credential]");
    expect(firstStdout).not.toContain("supersecret1234");
    expect(readFileSync(report.artifacts.events, "utf8")).toContain("step_finish");
    expect(readFileSync(report.artifacts.report, "utf8")).not.toContain("supersecret1234");
  });

  it("stops after the default three eligible infrastructure attempts and reports exhaustion", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-retry-exhausted-"));
    const repository = createRepository(scratch);
    const fixture = sequenceAdapter([transientFailureResult()]);
    const report = await runAgentHost({
      adapter: fixture.adapter,
      repository,
      task: "Bound infrastructure retries",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 0,
    });

    expect(fixture.run).toHaveBeenCalledTimes(3);
    expect(report.retry).toEqual({
      maxAttempts: 3,
      delayMs: 0,
      attempts: 3,
      retries: 2,
      exhausted: true,
    });
    expect(report.attempts.map((attempt) => attempt.retry.scheduled)).toEqual([true, true, false]);
    expect(report.session.status).toBe("failed");
    expect(report.succeeded).toBe(false);
  });

  it("does not retry a transient-looking failure after repository activity", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-retry-dirty-"));
    const repository = createRepository(scratch);
    const fixture = sequenceAdapter([transientFailureResult()]);
    fixture.adapter.run = async (request) => {
      writeFileSync(join(request.repository, "changed.txt"), "business activity\n", "utf8");
      return transientFailureResult();
    };
    const report = await runAgentHost({
      adapter: fixture.adapter,
      repository,
      task: "Do not retry after repository mutation",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 0,
    });

    expect(report.retry).toMatchObject({ attempts: 1, retries: 0, exhausted: false });
    expect(report.attempts[0]).toMatchObject({
      git: { unchanged: false },
      retry: { eligible: false, blockers: ["repository-changed-during-attempt"] },
    });
  });

  it.each([
    {
      name: "input tokens",
      result: transientFailureResult({
        events: { tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      }),
      blocker: "agent-produced-input-or-output-tokens",
    },
    {
      name: "tool and command activity",
      result: transientFailureResult({
        outcome: { commands: [{ command: "npm test", exitCode: 1, exitCodeKnown: true, isTest: true, summary: "failed" }] },
        events: { toolCalls: { bash: 1 }, failedCommands: 1 },
      }),
      blocker: "agent-observed-tools-commands-or-repomind-calls",
    },
    {
      name: "Host timeout",
      result: transientFailureResult({ process: { exitCode: null, timedOut: true } }),
      blocker: "attempt-was-aborted-signaled-or-host-timed-out",
    },
    {
      name: "abort signal",
      result: transientFailureResult({ process: { exitCode: null, signal: "SIGTERM", aborted: true } }),
      blocker: "attempt-was-aborted-signaled-or-host-timed-out",
    },
  ])("does not retry transient text after $name", async ({ result, blocker }) => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-retry-blocked-"));
    const repository = createRepository(scratch);
    const fixture = sequenceAdapter([result]);
    const report = await runAgentHost({
      adapter: fixture.adapter,
      repository,
      task: "Enforce strict retry blockers",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 0,
    });

    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(report.retry).toMatchObject({ attempts: 1, retries: 0 });
    expect(report.attempts[0]!.retry).toMatchObject({ eligible: false });
    expect(report.attempts[0]!.retry.blockers).toContain(blocker);
  });

  it("allows an upstream HTTP/2 failure to resume after local-only Agent activity", () => {
    const before = { branch: "main", head: "abc", dirty: false, status: "" };
    const after = { branch: "main", head: "abc", dirty: true, status: " M src/digest.js" };
    const execution: AgentHostRunResult = {
      ...transientFailureResult({
        process: {
          stdout: `${JSON.stringify({
            type: "error",
            sessionID: "ses_resume_safe",
            error: { data: { message: JSON.stringify({
              message: "Upstream HTTP/2 stream failed",
              type: "upstream_error",
              code: "upstream_http2_stream_error",
            }) } },
          })}\n`,
        },
        outcome: { summary: "OpenCode ended with exit code 1." },
        events: {
          tokens: { input: 12, output: 3, reasoning: 1, cacheRead: 4, cacheWrite: 0 },
          toolCalls: { apply_patch: 1, glob: 1, read: 2, todowrite: 1 },
          fileReads: 2,
        },
      }),
      continuationToken: "ses_resume_safe",
    };

    expect(assessAgentInfrastructureRetry({
      execution,
      snapshotBefore: before,
      snapshotAfter: after,
      resumeSupported: true,
      attemptMode: "fresh",
    })).toMatchObject({
      eligible: true,
      mode: "resume",
      matchedSignals: ["upstream-http2-stream"],
      blockers: [],
      conditions: {
        repositoryUnchanged: false,
        resumeSupported: true,
        resumeTokenAvailable: true,
        noCommandActivity: true,
        noRepoMindActivity: true,
        resumeSafeTools: true,
      },
    });
  });

  it.each([
    {
      name: "missing continuation token",
      continuationToken: undefined,
      commands: [],
      toolCalls: { read: 1 },
      repoMindCalls: 0,
      blocker: "missing-provider-session-token",
    },
    {
      name: "Bash command activity",
      continuationToken: "ses_blocked",
      commands: [{ command: "npm test", exitCode: 0, exitCodeKnown: true, isTest: true, summary: "passed" }],
      toolCalls: { bash: 1 },
      repoMindCalls: 0,
      blocker: "agent-observed-shell-or-command-activity",
    },
    {
      name: "external tool activity",
      continuationToken: "ses_blocked",
      commands: [],
      toolCalls: { webfetch: 1 },
      repoMindCalls: 0,
      blocker: "agent-observed-nonlocal-or-unsupported-tools",
    },
    {
      name: "RepoMind activity",
      continuationToken: "ses_blocked",
      commands: [],
      toolCalls: { repomind_memory_record: 1 },
      repoMindCalls: 1,
      blocker: "agent-observed-repomind-activity",
    },
  ])("blocks upstream resume after $name", ({ continuationToken, commands, toolCalls, repoMindCalls, blocker }) => {
    const snapshot = { branch: "main", head: "abc", dirty: false, status: "" };
    const execution: AgentHostRunResult = {
      ...transientFailureResult({
        process: { stdout: "upstream_http2_stream_error" },
        outcome: { summary: "Upstream HTTP/2 stream failed", commands },
        events: {
          tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          toolCalls,
          repoMindCalls,
        },
      }),
      ...(continuationToken ? { continuationToken } : {}),
    };
    const assessment = assessAgentInfrastructureRetry({
      execution,
      snapshotBefore: snapshot,
      snapshotAfter: snapshot,
      resumeSupported: true,
    });

    expect(assessment).toMatchObject({ eligible: false, mode: "none" });
    expect(assessment.blockers).toContain(blocker);
  });

  it("never falls back to a fresh process after a resumed attempt loses its session token", () => {
    const snapshot = { branch: "main", head: "abc", dirty: false, status: "" };
    const execution = transientFailureResult({
      process: { stdout: "upstream_http2_stream_error" },
      outcome: { summary: "Upstream HTTP/2 stream failed" },
    });

    const assessment = assessAgentInfrastructureRetry({
      execution,
      snapshotBefore: snapshot,
      snapshotAfter: snapshot,
      resumeSupported: true,
      attemptMode: "resume",
    });

    expect(assessment).toMatchObject({ eligible: false, mode: "none" });
    expect(assessment.conditions).toMatchObject({
      zeroInputOutputTokens: true,
      zeroAgentActivity: true,
      repositoryUnchanged: true,
      resumeTokenAvailable: false,
    });
    expect(assessment.blockers).toContain("missing-provider-session-token");
  });

  it("bounds repeated resume attempts and aggregates their Agent metrics", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-resume-exhausted-"));
    const repository = createRepository(scratch);
    const failure: AgentHostRunResult = {
      ...transientFailureResult({
        process: { stdout: "upstream_http2_stream_error", durationMs: 11 },
        outcome: { summary: "Upstream HTTP/2 stream failed" },
        events: {
          turns: 1,
          tokens: { input: 4, output: 1, reasoning: 1, cacheRead: 2, cacheWrite: 0 },
          toolCalls: { read: 1 },
          fileReads: 1,
        },
      }),
      continuationToken: "ses_resume_exhausted",
    };
    const run = vi.fn(async (request: Parameters<AgentHostAdapter["run"]>[0]) => {
      writeFileSync(join(request.repository, "local-edit.txt"), "in progress\n", "utf8");
      return failure;
    });
    const resume = vi.fn(async () => failure);
    const adapter: AgentHostAdapter<"fixture"> = {
      id: "fixture",
      displayName: "Fixture Agent",
      executable: "fixture-agent",
      validate: () => undefined,
      run,
      resume,
      version: async () => "fixture-agent 1.0",
    };

    const report = await runAgentHost({
      adapter,
      repository,
      task: "Bound resumable infrastructure failures",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 0,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(report.retry).toEqual({
      maxAttempts: 3,
      delayMs: 0,
      attempts: 3,
      retries: 2,
      exhausted: true,
    });
    expect(report.attempts.map((attempt) => attempt.executionMode)).toEqual(["fresh", "resume", "resume"]);
    expect(report.attempts.map((attempt) => attempt.retry.mode)).toEqual(["resume", "resume", "resume"]);
    expect(report.agent).toMatchObject({
      durationMs: 33,
      events: {
        turns: 3,
        tokens: { input: 12, output: 3, reasoning: 3, cacheRead: 6, cacheWrite: 0 },
        toolCalls: { read: 3 },
        fileReads: 3,
      },
    });
  });

  it("does not fake a resumed session for an adapter without resume support", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-agent-host-no-resume-"));
    const repository = createRepository(scratch);
    const failure: AgentHostRunResult = {
      ...transientFailureResult({
        process: { stdout: "upstream_http2_stream_error" },
        outcome: { summary: "Upstream HTTP/2 stream failed" },
        events: {
          tokens: { input: 4, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          toolCalls: { read: 1 },
          fileReads: 1,
        },
      }),
      continuationToken: "ses_adapter_cannot_resume",
    };
    const fixture = sequenceAdapter([failure, cleanResult()]);

    const report = await runAgentHost({
      adapter: fixture.adapter,
      repository,
      task: "Do not fake provider session persistence",
      dataDirectory: join(scratch, "data"),
      outputDirectory: join(scratch, "output"),
      retryDelayMs: 0,
    });

    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(report.retry).toMatchObject({ attempts: 1, retries: 0, exhausted: false });
    expect(report.attempts[0]!.retry).toMatchObject({ eligible: false, mode: "none" });
    expect(report.attempts[0]!.retry.blockers).toContain("adapter-does-not-support-session-resume");
  });
});
