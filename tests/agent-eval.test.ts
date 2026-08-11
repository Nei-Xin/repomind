import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { analyzeAgentEvents } from "../src/eval/agent/events.js";
import { aggregateAgentReports, renderAgentAggregateMarkdown } from "../src/eval/agent/aggregate.js";
import { hashAgentManifest, loadAgentManifest, parseAgentManifest } from "../src/eval/agent/manifest.js";
import { buildAgentReport, type AgentArm, type AgentRunResult } from "../src/eval/agent/report.js";
import { parseChangedFiles, runAgentEvaluation, type ProcessExecutor } from "../src/eval/agent/runner.js";
import { analyzeOpenCodeOutcome, assessOpenCodeOutcome } from "../src/integrations/opencode/lifecycle.js";

const TEST_PROVENANCE = {
  repoMindVersion: "test", repoMindCommit: "abc", repoMindDirty: false, node: process.version,
  os: { platform: process.platform, release: "test", arch: process.arch },
  runnerVersion: "test", manifestSha256: "0".repeat(64), taskBaseCommits: { history: "abc" },
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("agent event analysis", () => {
  it("counts tokens, tools, reads, and RepoMind retrieval", () => {
    const metrics = analyzeAgentEvents([
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 1 } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "README.md" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "README.md" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "error", input: { filePath: "missing.md" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } } }),
      "not json",
    ].join("\n"));
    expect(metrics).toMatchObject({
      turns: 1,
      fileReads: 2,
      failedFileReads: 1,
      repeatedFileReads: 1,
      repoMindCalls: 1,
      retrievedMemories: 1,
    });
    expect(metrics.tokens).toEqual({ input: 12, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 1 });
  });

  it("extracts the final response and test evidence for host commits", () => {
    const outcome = analyzeOpenCodeOutcome([
      JSON.stringify({ type: "tool_use", part: { tool: "bash", state: {
        status: "completed", input: { command: "npm test" }, output: "2 tests passed", metadata: { exit: 0 },
      } } }),
      JSON.stringify({ type: "text", part: { text: "Fixed the invoice calculation." } }),
    ].join("\n"), "fallback");
    expect(outcome.summary).toBe("Fixed the invoice calculation.");
    expect(outcome.commands).toEqual([{
      command: "npm test", exitCode: 0, exitCodeKnown: true, summary: "2 tests passed", isTest: true,
    }]);
    expect(outcome.trace).toMatchObject({ terminal: "incomplete", malformedLines: 0, unknownCommandResults: 0 });

    const bounded = analyzeOpenCodeOutcome(
      JSON.stringify({ type: "text", part: { text: `result\u0000${"x".repeat(20_000)}` } }),
      "fallback",
    );
    expect(bounded.summary.length).toBeLessThanOrEqual(12_000);
    expect(bounded.summary).toContain("[truncated by RepoMind host]");
    expect(bounded.summary).not.toContain("\u0000");
  });

  it("separates recovered command failures from terminal failures", () => {
    const command = (value: string, exitCode: number) => ({
      command: value, exitCode, exitCodeKnown: true, summary: "", isTest: false,
    });
    const observed = [
      command("node --input-type=module -e \"broken probe\"", 1),
      command("node --input-type=module -e \"corrected probe\"", 0),
    ];
    expect(assessOpenCodeOutcome({
      agentExitCode: 0,
      commands: observed,
    })).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["unrecovered-command-failure"],
      commands: { failed: 1, recovered: 0, unrecovered: 1 },
      authoritativeVerification: { checks: 0, passed: null },
    });
    expect(assessOpenCodeOutcome({
      agentExitCode: 0,
      commands: observed,
      authoritativeChecks: [{ exitCode: 0 }, { exitCode: 0 }],
    })).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: expect.arrayContaining(["unrecovered-command-failure", "verification-snapshot-changed"]),
    });
    expect(assessOpenCodeOutcome({
      agentExitCode: 0,
      commands: observed,
      authoritativeChecks: [{ exitCode: 0 }, { exitCode: 0 }],
      verificationSnapshotStable: true,
    })).toMatchObject({
      completion: "recovered",
      status: "success",
      maintenanceEligible: true,
      qualityFlags: ["recovered-command-failure"],
      commands: { observed: 2, failed: 1, recovered: 1, unrecovered: 0 },
      authoritativeVerification: { authority: "host-config", checks: 2, passed: true, snapshotStable: true },
    });
    expect(assessOpenCodeOutcome({
      agentExitCode: 0,
      commands: [command("npm run build", 1), command("git status --short", 0)],
    })).toMatchObject({
      completion: "inconclusive",
      status: "partial",
      maintenanceEligible: false,
      qualityFlags: ["unrecovered-command-failure"],
      commands: { failed: 1, recovered: 0, unrecovered: 1 },
      authoritativeVerification: { authority: "none", checks: 0, passed: null, snapshotStable: null },
    });
  });
});

describe("Git porcelain parsing", () => {
  it("preserves the first character of unstaged paths", () => {
    expect(parseChangedFiles(" M src/index.js\n?? test/new.test.js\n")).toEqual(["src/index.js", "test/new.test.js"]);
  });
});

describe("agent manifest", () => {
  const task = {
    id: "task-one", baseRepository: ".", baseCommit: "HEAD", prompt: "Do it",
    publicChecks: [{ command: "node", args: ["--version"] }],
    hiddenChecks: [{ command: "node", args: ["--version"] }],
    memories: [{ type: "decision" as const, title: "Rule", content: "Use the rule." }],
  };

  it("applies defaults and rejects duplicate task ids", () => {
    expect(parseAgentManifest({ version: 1, name: "suite", tasks: [task] }).tasks[0]!.publicChecks[0]!.args).toEqual(["--version"]);
    expect(() => parseAgentManifest({ version: 1, name: "suite", tasks: [task, task] })).toThrow(/duplicate task ids/);
  });

  it("rejects acceptance wins that reference unknown tasks", () => {
    expect(() => parseAgentManifest({
      version: 1, name: "suite", tasks: [task], acceptance: { requiredTaskWins: ["missing"] },
    })).toThrow(/unknown task ids: missing/);
  });

  it("requires raw full history for every version 2 task", () => {
    expect(() => parseAgentManifest({ version: 2, name: "suite", tasks: [task] })).toThrow(/require fullHistory/);
    expect(parseAgentManifest({ version: 2, name: "suite", tasks: [{ ...task, fullHistory: ["Earlier attempt failed."] }] }).version).toBe(2);
  });

  it("hashes the exact manifest bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-manifest-"));
    const path = join(root, "manifest.json");
    try {
      writeFileSync(path, "{\"version\":1}\n", "utf8");
      expect(hashAgentManifest(path)).toBe("50208d78350a7a160dec59a82df1499b6ca7da33e54c5eb11c97e342118e68bb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function reportRun(arm: AgentArm, hiddenPass: boolean): AgentRunResult {
  const repoMind = arm === "repomind";
  const wallDurationMs = repoMind ? 110 : arm === "full-history" ? 120 : 100;
  return {
    taskId: "history", arm, iteration: 1, repository: `/${arm}`,
    requestedCommit: "abc", baseCommit: "abc", agentExitCode: 0, agentSignal: null,
    startMs: repoMind ? null : 0, agentMs: wallDurationMs, commitMs: repoMind ? null : 0,
    maintenanceMs: repoMind ? null : 0,
    totalLifecycleMs: wallDurationMs, wallDurationMs,
    publicChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    hiddenChecks: [{ command: "node", args: [], exitCode: hiddenPass ? 0 : 1, signal: null, stdout: "", stderr: "", durationMs: 1, passed: hiddenPass }],
    changedFiles: ["answer.js"], unexpectedChanges: [],
    sessionsBeforeCleanup: repoMind ? [{ id: "s1", status: "committed" }] : [],
    abandonedSessions: 0, openSessionsAfterCleanup: 0,
    lifecycle: {
      mode: repoMind ? "agent-managed" : "none", timing: repoMind ? "nested-in-agent" : "not-applicable",
      startAttempted: repoMind, startSucceeded: repoMind, sessionId: repoMind ? "s1" : null,
      retrievedMemories: repoMind ? 1 : 0, commitAttempted: repoMind, commitSucceeded: repoMind,
      commitStatus: repoMind ? "committed" : null, maintenanceAttempted: false, maintenanceStatus: null,
      evidenceCreated: 0, error: null,
    },
    contextTelemetry: repoMind
      ? { availability: "unavailable", reason: "agent-managed fixture" }
      : { availability: "not-applicable", reason: "baseline fixture" },
    maintenanceTelemetry: repoMind
      ? { availability: "unavailable", reason: "agent-managed fixture" }
      : { availability: "not-applicable", reason: "baseline fixture" },
    quality: null,
    events: {
      turns: 1,
      tokens: { input: repoMind ? 70 : arm === "full-history" ? 130 : 100, output: repoMind ? 12 : 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: repoMind ? { repomind_repo_session_start: 1 } : {}, failedTools: 0, failedCommands: 0,
      fileReads: repoMind ? 3 : arm === "full-history" ? 4 : 5, failedFileReads: 0,
      repeatedFileReads: 0, repoMindCalls: repoMind ? 2 : 0,
      retrievedMemories: repoMind ? 1 : 0,
    },
  };
}

describe("paired agent report", () => {
  it("computes paired deltas and evaluates explicit acceptance criteria", () => {
    const report = buildAgentReport({
      name: "paired", runner: "opencode", model: "test", repeat: 1, outputDirectory: "/tmp",
      provenance: TEST_PROVENANCE,
      runs: [reportRun("no-memory", false), reportRun("full-history", false), reportRun("repomind", true)],
      acceptanceCriteria: {
        minRepoMindHiddenPassRate: 1,
        minHiddenPassRateDelta: 0.5,
        minFullHistoryHiddenPassRateDelta: 0.5,
        minRetrievalRate: 1,
        minSessionCommitRate: 1,
        maxMeanDurationRegressionPercent: 15,
        maxFullHistoryDurationRegressionPercent: 0,
        requireEfficiencyImprovement: true,
        requiredTaskWins: ["history"],
        requiredFullHistoryTaskWins: ["history"],
      },
    });
    expect(report.integrity.passed).toBe(true);
    expect(report.acceptance.status).toBe("passed");
    expect(report.comparisons["no-memory"]?.pairs).toBe(1);
    expect(report.comparisons["no-memory"]?.overall.find((metric) => metric.key === "hiddenSuccess")).toMatchObject({
      meanDelta: 1, repoMindWins: 1, ties: 0, repoMindLosses: 0,
    });
    expect(report.comparisons["full-history"]?.overall.find((metric) => metric.key === "hiddenSuccess")?.meanDelta).toBe(1);
    expect(report.comparisons["no-memory"]?.overall.find((metric) => metric.key === "inputTokens")?.relativeDeltaPercent).toBe(-30);
    expect(report.comparisons["no-memory"]?.overall.find((metric) => metric.key === "wallDurationMs")?.relativeDeltaPercent).toBe(10);
  });

  it("reports an acceptance failure without changing integrity", () => {
    const report = buildAgentReport({
      name: "paired", runner: "opencode", model: "test", repeat: 1, outputDirectory: "/tmp",
      provenance: TEST_PROVENANCE,
      runs: [reportRun("no-memory", false), reportRun("repomind", true)],
      acceptanceCriteria: { maxMeanDurationRegressionPercent: 5 },
    });
    expect(report.integrity.passed).toBe(true);
    expect(report.acceptance.status).toBe("failed");
    expect(report.acceptance.checks.find((check) => check.id === "durationRegression:no-memory")?.passed).toBe(false);
  });

  it("reports a missing required pair as failed acceptance instead of throwing", () => {
    const report = buildAgentReport({
      name: "incomplete", runner: "opencode", model: "test", repeat: 1, outputDirectory: "/tmp",
      provenance: TEST_PROVENANCE,
      runs: [reportRun("no-memory", false)], acceptanceCriteria: { requiredTaskWins: ["history"] },
    });
    expect(report.integrity.passed).toBe(false);
    expect(report.acceptance.status).toBe("failed");
    expect(report.acceptance.checks.find((check) => check.id === "requiredTaskWin:no-memory:history")).toMatchObject({
      passed: false, measured: false,
    });
  });
});

describe("aggregate agent report", () => {
  it("records source schemas and keeps missing legacy telemetry distinct from zero", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-aggregate-"));
    try {
      const schemas = [7, 4, 5, 6] as const;
      const paths = schemas.map((schemaVersion, index) => {
        const name = `report-v${schemaVersion}.json`;
        const report = buildAgentReport({
          name, runner: "opencode", model: `model-${schemaVersion}`, repeat: 1, outputDirectory: root,
          provenance: { ...TEST_PROVENANCE, os: { ...TEST_PROVENANCE.os, platform: index ? "linux" : "win32" } },
          runs: [reportRun("no-memory", false), reportRun("full-history", false), reportRun("repomind", true)],
        });
        const serialized = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
        serialized.version = schemaVersion;
        if (schemaVersion < 7) {
          delete serialized.repoMindLifecycle;
          for (const run of serialized.runs as Array<Record<string, unknown>>) {
            delete run.startMs;
            delete run.agentMs;
            delete run.commitMs;
            delete run.maintenanceMs;
            delete run.totalLifecycleMs;
            delete run.lifecycle;
            delete run.contextTelemetry;
            delete run.maintenanceTelemetry;
            delete run.quality;
          }
        }
        const path = join(root, name);
        writeFileSync(path, `${JSON.stringify(serialized)}\n`, "utf8");
        return path;
      });
      const aggregate = aggregateAgentReports(paths);
      expect(aggregate).toMatchObject({ version: 2, reportCount: 4, runCount: 12, integrity: { passed: true } });
      expect(aggregate.reports.map((report) => report.schemaVersion)).toEqual(schemas);
      expect(aggregate.telemetryCoverage).toEqual({
        context: { total: 12, full: 0, unavailable: 1, notApplicable: 2, missing: 9 },
        maintenance: { total: 12, full: 0, unavailable: 1, notApplicable: 2, missing: 9 },
        quality: { total: 12, full: 0, unavailable: 0, notApplicable: 3, missing: 9 },
      });
      expect(aggregate.comparisons["no-memory"]?.find((metric) => metric.key === "hiddenSuccess")).toMatchObject({
        pairs: 4, meanDelta: 1, confidence95: { low: 1, high: 1 }, repoMindWins: 4,
      });
      expect(aggregate.reports[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const markdown = renderAgentAggregateMarkdown(aggregate);
      expect(markdown).toContain("RepoMind vs full-history");
      expect(markdown).toContain("Telemetry coverage");
      expect(markdown).toContain("Missing means the source run did not contain the field");
      expect(markdown).toContain("| report-v4.json | v4 |");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("controlled agent evaluation", () => {
  it("runs isolated rotating arms and writes reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-eval-"));
    const base = join(root, "base");
    const output = join(root, "output");
    try {
      spawnSync("git", ["init", "-q", base], { encoding: "utf8" });
      writeFileSync(join(base, "answer.txt"), "base\n", "utf8");
      git(base, ["add", "."]);
      git(base, ["-c", "user.name=RepoMind", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
      const commit = git(base, ["rev-parse", "HEAD"]);
      const real: ProcessExecutor = (request) => spawnSync(request.command, request.args, {
        cwd: request.cwd, env: { ...process.env, ...request.env }, encoding: "utf8",
        timeout: request.timeoutMs, windowsHide: true, shell: false,
      });
      const prompts: string[] = [];
      const runnerArgs: string[][] = [];
      const execute: ProcessExecutor = (request) => {
        if (request.command === "fake-opencode") {
          if (request.args[0] === "--version") {
            return { status: 0, signal: null, stdout: "fake-opencode 1.0\n", stderr: "", error: undefined } as SpawnSyncReturns<string>;
          }
          runnerArgs.push(request.args);
          prompts.push(request.args.at(-1) ?? "");
          const config = JSON.parse(readFileSync(join(request.cwd, "opencode.json"), "utf8")) as { mcp: Record<string, unknown> };
          const events: Array<Record<string, unknown>> = [];
          if (request.cwd.includes("host-repomind-1")) {
            events.push(
              { type: "tool_use", part: { tool: "shell", state: { status: "completed", input: { command: "node --input-type=module -e \"broken probe\"" }, output: "failed", metadata: { exit: 1 } } } },
              { type: "tool_use", part: { tool: "shell", state: { status: "completed", input: { command: "node --input-type=module -e \"corrected probe\"" }, output: "passed", metadata: { exit: 0 } } } },
            );
          }
          events.push({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 2 } } });
          if (config.mcp.repomind) events.push({
            type: "tool_use",
            part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } },
          } as never);
          return { status: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", error: undefined } as SpawnSyncReturns<string>;
        }
        return real(request);
      };
      const report = await runAgentEvaluation({
        manifest: parseAgentManifest({
          version: 2, name: "fake suite", tasks: [{
            id: "smoke", baseRepository: base, baseCommit: commit, prompt: "Do it",
            publicChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            hiddenChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            memories: [{ type: "decision", title: "Hidden rule", content: "The historical answer." }],
            fullHistory: ["A failed attempt used the legacy answer.", "The latest discussion selected the historical answer."],
            allowedChanges: [],
          }],
        }),
        model: "test/model", repeat: 2, outputDirectory: output,
        repoMindCli: join(process.cwd(), "dist", "cli", "index.js"),
        runnerExecutable: "fake-opencode", execute,
      });
      expect(report.runs.map((run) => `${run.arm}-${run.iteration}`)).toEqual([
        "no-memory-1", "full-history-1", "repomind-1",
        "full-history-2", "repomind-2", "no-memory-2",
      ]);
      expect(report.arms["no-memory"].repoMindCalls).toBe(0);
      expect(report.arms["full-history"]?.repoMindCalls).toBe(0);
      expect(report.arms.repomind.repoMindCalls).toBe(2);
      expect(report.provenance).toMatchObject({
        repoMindCommit: expect.stringMatching(/^[a-f0-9]{40}$/u),
        repoMindDirty: expect.any(Boolean),
        runnerVersion: "fake-opencode 1.0",
        taskBaseCommits: { smoke: commit },
      });
      expect(report.version).toBe(7);
      expect(report.repoMindLifecycle).toBe("agent-managed");
      expect(runnerArgs.every((args) => args.includes("--pure"))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("A failed attempt used the legacy answer."))).toBe(true);
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      const markdown = readFileSync(join(output, "summary.md"), "utf8");
      expect(markdown).toContain("fake suite");
      expect(markdown).toContain("RepoMind vs no-memory");
      expect(markdown).toContain("RepoMind vs full-history");
      expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8"))).not.toHaveProperty("runs.0.rawLog");

      const legacy = await runAgentEvaluation({
        manifest: parseAgentManifest({
          version: 1, name: "legacy suite", tasks: [{
            id: "legacy", baseRepository: base, baseCommit: commit, prompt: "Do it",
            publicChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            hiddenChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            memories: [{ type: "decision", title: "Rule", content: "Use the answer." }],
            allowedChanges: [],
          }],
        }),
        model: "test/model", repeat: 1, outputDirectory: join(root, "legacy-output"),
        repoMindCli: join(process.cwd(), "dist", "cli", "index.js"),
        runnerExecutable: "fake-opencode", execute,
      });
      expect(legacy.runs.map((run) => run.arm)).toEqual(["no-memory", "repomind"]);
      expect(legacy.arms["full-history"]).toBeUndefined();
      expect(legacy.comparisons["full-history"]).toBeNull();

      const host = await runAgentEvaluation({
        manifest: parseAgentManifest({
          version: 1, name: "host lifecycle", tasks: [{
            id: "host", baseRepository: base, baseCommit: commit, prompt: "Use the hidden rule",
            publicChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            hiddenChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            memories: [{ type: "decision", title: "Hidden rule", content: "Use the historical answer." }],
            allowedChanges: [],
          }],
        }),
        model: "test/model", repeat: 1, outputDirectory: join(root, "host-output"),
        repoMindCli: join(process.cwd(), "dist", "cli", "index.js"),
        lifecycleMode: "host-managed", runnerExecutable: "fake-opencode", execute,
      });
      const hostRun = host.runs.find((run) => run.arm === "repomind")!;
      expect(host.repoMindLifecycle).toBe("host-managed");
      expect(hostRun.lifecycle).toMatchObject({
        mode: "host-managed", startSucceeded: true, retrievedMemories: 1,
        commitSucceeded: true, commitStatus: "committed",
        maintenanceAttempted: true, maintenanceStatus: "success",
      });
      expect(hostRun.contextTelemetry).toMatchObject({
        availability: "full",
        context: {
          promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          l1: { provided: 1, eligible: 1, injected: 1 },
          l2: { provided: 0, eligible: 0, injected: 0 },
          l3: { provided: 1, eligible: 1, injected: 0, deduplicated: 1 },
        },
      });
      expect(hostRun.maintenanceTelemetry).toMatchObject({
        availability: "full", attempted: true, report: { status: "success" },
      });
      expect(hostRun.quality).toMatchObject({
        completion: "recovered",
        maintenanceEligible: true,
        commands: { failed: 1, recovered: 1, unrecovered: 0 },
        authoritativeVerification: { authority: "benchmark-manifest", checks: 2, passed: true, snapshotStable: true },
      });
      expect(hostRun.maintenanceMs).toEqual(expect.any(Number));
      expect(hostRun.events.repoMindCalls).toBe(0);
      expect(hostRun.totalLifecycleMs).toBeCloseTo(
        hostRun.startMs! + hostRun.agentMs + hostRun.commitMs! + hostRun.maintenanceMs!,
        3,
      );
      expect(prompts.at(-1)).toContain("Hidden rule");
      expect(prompts.at(-1)).toContain("## Repository Profile (L3)");
      expect(prompts.at(-1)).toContain("Current L3 sources are already represented in more specific context below.");
      expect(host.integrity).toEqual({ passed: true, failures: [] });
      const hostCore = new RepositoryMemoryCore(hostRun.repository, {
        dataDirectory: join(root, "host-output", "data", "host-repomind-1"),
      });
      try {
        const tests = hostCore.context.database.raw.prepare(
          "SELECT count(*) AS count FROM evidence WHERE kind='test_result'",
        ).get() as { count: number };
        expect(Number(tests.count)).toBe(1);
      } finally {
        hostCore.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("reproducible agent suite", () => {
  it("creates committed fixture repositories and refuses to overwrite them", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-suite-"));
    const target = join(root, "generated");
    const secondTarget = join(root, "generated-again");
    const script = join(process.cwd(), "benchmarks", "agent-suite", "create.mjs");
    try {
      const created = spawnSync(process.execPath, [script, target], { encoding: "utf8", windowsHide: true });
      expect(created.status, created.stderr).toBe(0);
      const manifest = loadAgentManifest(join(target, "manifest.json"));
      const second = spawnSync(process.execPath, [script, secondTarget], { encoding: "utf8", windowsHide: true });
      expect(second.status, second.stderr).toBe(0);
      const secondManifest = loadAgentManifest(join(secondTarget, "manifest.json"));
      expect(manifest.tasks.map((task) => task.id)).toEqual([
        "renamed-module", "failed-solution", "migration-rollback", "historical-command",
        "stale-endpoint", "error-contract", "dependency-boundary", "config-default",
      ]);
      expect(manifest.acceptance).toMatchObject({
        minRepoMindHiddenPassRate: 1, requiredTaskWins: ["historical-command"],
      });
      for (const [index, task] of manifest.tasks.entries()) {
        const commit = git(task.baseRepository, ["rev-parse", "HEAD"]);
        expect(commit).toMatch(/^[a-f0-9]{40}$/u);
        expect(task.baseCommit).toBe(commit);
        expect(secondManifest.tasks[index]!.baseCommit).toBe(commit);
        expect(git(task.baseRepository, ["status", "--short"])).toBe("");
        expect(task.hiddenChecks[0]!.args[0]).toContain(target);
      }
      const repeated = spawnSync(process.execPath, [script, target], { encoding: "utf8", windowsHide: true });
      expect(repeated.status).toBe(1);
      expect(repeated.stderr).toContain("Refusing to overwrite");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
