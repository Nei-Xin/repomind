import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAgentEvents } from "../src/eval/agent/events.js";
import { aggregateAgentReports, renderAgentAggregateMarkdown } from "../src/eval/agent/aggregate.js";
import { hashAgentManifest, loadAgentManifest, parseAgentManifest } from "../src/eval/agent/manifest.js";
import { buildAgentReport, type AgentArm, type AgentRunResult } from "../src/eval/agent/report.js";
import { parseChangedFiles, runAgentEvaluation, type ProcessExecutor } from "../src/eval/agent/runner.js";

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
      JSON.stringify({ type: "tool_use", part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } } }),
      "not json",
    ].join("\n"));
    expect(metrics).toMatchObject({ turns: 1, fileReads: 2, repeatedFileReads: 1, repoMindCalls: 1, retrievedMemories: 1 });
    expect(metrics.tokens).toEqual({ input: 12, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 1 });
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
  return {
    taskId: "history", arm, iteration: 1, repository: `/${arm}`,
    requestedCommit: "abc", baseCommit: "abc", agentExitCode: 0, agentSignal: null,
    wallDurationMs: repoMind ? 110 : arm === "full-history" ? 120 : 100,
    publicChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    hiddenChecks: [{ command: "node", args: [], exitCode: hiddenPass ? 0 : 1, signal: null, stdout: "", stderr: "", durationMs: 1, passed: hiddenPass }],
    changedFiles: ["answer.js"], unexpectedChanges: [],
    sessionsBeforeCleanup: repoMind ? [{ id: "s1", status: "committed" }] : [],
    abandonedSessions: 0, openSessionsAfterCleanup: 0,
    events: {
      turns: 1,
      tokens: { input: repoMind ? 70 : arm === "full-history" ? 130 : 100, output: repoMind ? 12 : 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: repoMind ? { repomind_repo_session_start: 1 } : {}, failedTools: 0, failedCommands: 0,
      fileReads: repoMind ? 3 : arm === "full-history" ? 4 : 5, repeatedFileReads: 0, repoMindCalls: repoMind ? 2 : 0,
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
  it("recomputes paired metrics from traceable version 4 source reports", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-aggregate-"));
    try {
      const paths = ["windows.json", "ubuntu.json"].map((name, index) => {
        const report = buildAgentReport({
          name, runner: "opencode", model: index ? "model-b" : "model-a", repeat: 1, outputDirectory: root,
          provenance: { ...TEST_PROVENANCE, os: { ...TEST_PROVENANCE.os, platform: index ? "linux" : "win32" } },
          runs: [reportRun("no-memory", false), reportRun("full-history", false), reportRun("repomind", true)],
        });
        const path = join(root, name);
        writeFileSync(path, `${JSON.stringify(report)}\n`, "utf8");
        return path;
      });
      const aggregate = aggregateAgentReports(paths);
      expect(aggregate).toMatchObject({ reportCount: 2, runCount: 6, integrity: { passed: true } });
      expect(aggregate.models).toEqual(["model-a", "model-b"]);
      expect(aggregate.comparisons["no-memory"]?.find((metric) => metric.key === "hiddenSuccess")).toMatchObject({
        pairs: 2, meanDelta: 1, confidence95: { low: 1, high: 1 }, repoMindWins: 2,
      });
      expect(aggregate.reports[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(renderAgentAggregateMarkdown(aggregate)).toContain("RepoMind vs full-history");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("controlled agent evaluation", () => {
  it("runs isolated rotating arms and writes reports", () => {
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
          const events = [{ type: "step_finish", part: { tokens: { input: 10, output: 2 } } }];
          if (config.mcp.repomind) events.push({
            type: "tool_use",
            part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } },
          } as never);
          return { status: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", error: undefined } as SpawnSyncReturns<string>;
        }
        return real(request);
      };
      const report = runAgentEvaluation({
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
      expect(report.version).toBe(4);
      expect(runnerArgs.every((args) => args.includes("--pure"))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("A failed attempt used the legacy answer."))).toBe(true);
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      const markdown = readFileSync(join(output, "summary.md"), "utf8");
      expect(markdown).toContain("fake suite");
      expect(markdown).toContain("RepoMind vs no-memory");
      expect(markdown).toContain("RepoMind vs full-history");
      expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8"))).not.toHaveProperty("runs.0.rawLog");

      const legacy = runAgentEvaluation({
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
