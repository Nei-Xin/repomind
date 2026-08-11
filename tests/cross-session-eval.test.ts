import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import {
  type CrossSessionRunner,
  hashCrossSessionManifest,
  loadCrossSessionManifest,
  parseCrossSessionManifest,
} from "../src/eval/agent/cross-session-manifest.js";
import { runCrossSessionEvaluation, type CrossSessionProcessExecutor } from "../src/eval/agent/cross-session-runner.js";
import { buildCrossSessionReport } from "../src/eval/agent/cross-session-report.js";
import { renderHostContext } from "../src/integrations/opencode/context.js";
import type { AgentHostAdapter } from "../src/integrations/agent-host/types.js";
import type { OpenCodeProcessExecutor } from "../src/integrations/opencode/run.js";

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function manifest(baseRepository: string, baseCommit: string) {
  const check = (expected: string, hidden = false) => ({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs');const ok=fs.readFileSync(process.argv[1],'utf8')===${JSON.stringify(`${expected}\n`)};${hidden ? "if(ok)process.stdout.write('HIDDEN-SENTINEL');" : ""}process.exit(ok?0:1)`,
      "{repo}/answer.txt",
    ],
  });
  return parseCrossSessionManifest({
    version: 1,
    name: "cross-session fixture",
    acceptance: {
      minSharedTransferHiddenPassRate: 1,
      minTransferHiddenPassRateDelta: 0,
      minSharedRecallRate: 1,
      maxIsolatedRecallRate: 0,
      minSharedCommitRate: 1,
    },
    sequences: [{
      id: "release-flow",
      baseRepository,
      baseCommit,
      stages: [{
        id: "producer",
        prompt: "Implement the first release handshake and establish its repository convention.",
        publicChecks: [check("producer")],
        hiddenChecks: [check("producer", true)],
        allowedChanges: ["answer.txt", "decision.txt"],
      }, {
        id: "consumer",
        prompt: "Implement the next release handshake by reusing the repository convention from the earlier task.",
        publicChecks: [check("consumer")],
        hiddenChecks: [check("consumer", true)],
        allowedChanges: ["answer.txt"],
      }],
    }],
  });
}

function answerCheck(expected: string, hidden = false) {
  return {
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs');const ok=fs.readFileSync(process.argv[1],'utf8')===${JSON.stringify(`${expected}\n`)};${hidden ? "if(ok)process.stdout.write('HIDDEN-SENTINEL');" : ""}process.exit(ok?0:1)`,
      "{repo}/answer.txt",
    ],
  };
}

function mixedAdapter(
  runner: CrossSessionRunner,
  calls: Array<{ runner: CrossSessionRunner; model: string | null; prompt: string }>,
): AgentHostAdapter<CrossSessionRunner> {
  return {
    id: runner,
    displayName: `${runner} fixture`,
    executable: `fake-${runner}`,
    validate: () => undefined,
    version: async () => `${runner} fixture 1.0`,
    run: async (request) => {
      calls.push({ runner, model: request.model, prompt: request.prompt });
      const producer = request.prompt.includes("PRODUCER_TASK");
      const recalled = request.prompt.includes("cyan-token");
      writeFileSync(join(request.repository, "answer.txt"), `${producer ? "producer" : "consumer"}\n`, "utf8");
      return {
        process: {
          exitCode: 0,
          signal: null,
          stdout: `${runner} fixture event stream\n`,
          stderr: "",
          durationMs: recalled ? 5 : 10,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        outcome: {
          summary: producer
            ? "Implemented the producer task. The reusable release handshake repository convention is cyan-token."
            : "Implemented the consumer task using the established repository convention.",
          commands: [],
          trace: {
            parsedEvents: 2,
            malformedLines: 0,
            explicitErrors: 0,
            unknownCommandResults: 0,
            terminal: "clean-stop",
          },
        },
        events: {
          turns: 1,
          tokens: { input: recalled ? 10 : 20, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          toolCalls: {},
          failedTools: 0,
          failedCommands: 0,
          fileReads: recalled ? 0 : 1,
          failedFileReads: 0,
          repeatedFileReads: 0,
          repoMindCalls: 0,
          retrievedMemories: 0,
        },
      };
    },
  };
}

describe("cross-session manifest", () => {
  it("requires unique sequence and stage ids", () => {
    const base = {
      id: "flow",
      baseRepository: ".",
      baseCommit: "HEAD",
      stages: [
        { id: "one", prompt: "one", publicChecks: [{ command: "node" }], hiddenChecks: [{ command: "node" }] },
        { id: "two", prompt: "two", publicChecks: [{ command: "node" }], hiddenChecks: [{ command: "node" }] },
      ],
    };
    expect(() => parseCrossSessionManifest({ version: 1, name: "x", sequences: [base, base] }))
      .toThrow(/duplicate sequence ids/u);
    expect(() => parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [{ ...base, stages: [base.stages[0], base.stages[0]] }],
    })).toThrow(/duplicate stage ids/u);
    expect(parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [base],
      acceptance: { minComparablePairCoverageRate: 0.75 },
    }).acceptance).toMatchObject({ minComparablePairCoverageRate: 0.75 });
    expect(parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [{
        ...base,
        stages: [base.stages[0], { ...base.stages[1], maxMemories: 0 }],
      }],
      acceptance: {
        minSharedDerivedRecallRate: 1,
        minSharedL2RecallRate: 1,
        minSharedL3RecallRate: 1,
        maxSharedDerivedStageL1RecallRate: 0,
        maxIsolatedDerivedRecallRate: 0,
      },
    }).sequences[0]!.stages[1]!.maxMemories).toBe(0);
    expect(parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [base],
      acceptance: {
        maxMeanTotalPromptTokenRegressionPercent: 10,
        minTotalPromptTokenPairedWinRate: 0.6,
      },
    }).acceptance).toMatchObject({
      maxMeanTotalPromptTokenRegressionPercent: 10,
      minTotalPromptTokenPairedWinRate: 0.6,
    });
    expect(() => parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [base],
      acceptance: { minComparablePairCoverageRate: 1.01 },
    })).toThrow(/Invalid cross-session manifest/u);
    expect(() => parseCrossSessionManifest({
      version: 1,
      name: "x",
      sequences: [base],
      acceptance: { minTotalPromptTokenPairedWinRate: 1.01 },
    })).toThrow(/Invalid cross-session manifest/u);
  });

  it("loads relative repositories and hashes exact manifest bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-cross-manifest-"));
    const path = join(root, "manifest.json");
    try {
      const value = {
        version: 1,
        name: "x",
        sequences: [{
          id: "flow", baseRepository: "./base", baseCommit: "HEAD",
          stages: ["one", "two"].map((id) => ({
            id, prompt: id, publicChecks: [{ command: "node" }], hiddenChecks: [{ command: "node" }],
          })),
        }],
      };
      writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
      expect(loadCrossSessionManifest(path).sequences[0]!.baseRepository).toBe(join(root, "base"));
      expect(hashCrossSessionManifest(path)).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit stage model whenever the resolved runner switches", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-cross-runner-model-"));
    try {
      const value = parseCrossSessionManifest({
        version: 1,
        name: "invalid runner switch",
        sequences: [{
          id: "flow",
          baseRepository: ".",
          stages: [{
            id: "producer",
            runner: "claude",
            prompt: "producer",
            publicChecks: [{ command: "node" }],
            hiddenChecks: [{ command: "node" }],
          }, {
            id: "consumer",
            runner: "opencode",
            model: "test/opencode",
            prompt: "consumer",
            publicChecks: [{ command: "node" }],
            hiddenChecks: [{ command: "node" }],
          }],
        }],
      });
      await expect(runCrossSessionEvaluation({
        manifest: value,
        model: "default/model",
        repeat: 1,
        outputDirectory: join(root, "output"),
        repoMindRoot: process.cwd(),
      })).rejects.toThrow(/switches runner from opencode to claude and requires an explicit model/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cross-session learning evaluation", () => {
  it("compares shared learning with fresh per-stage databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-cross-eval-"));
    const base = join(root, "base");
    const outputBase = join(root, "output");
    const longestRunName = "release-flow-isolated-1-s2-consumer";
    const longPathPadding = Math.max(0, 181 - join(outputBase, "runs", longestRunName).length);
    const output = `${outputBase}${"x".repeat(longPathPadding)}`;
    try {
      spawnSync("git", ["init", "-q", base], { encoding: "utf8", windowsHide: true });
      writeFileSync(join(base, "answer.txt"), "base\n", "utf8");
      writeFileSync(join(base, "decision.txt"), "cyan-token\n", "utf8");
      git(base, ["add", "."]);
      git(base, ["-c", "user.name=RepoMind", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
      const commit = git(base, ["rev-parse", "HEAD"]);
      const real: CrossSessionProcessExecutor = (request) => spawnSync(request.command, request.args, {
        cwd: request.cwd,
        encoding: "utf8",
        timeout: request.timeoutMs,
        windowsHide: true,
        shell: false,
      });
      const execute: CrossSessionProcessExecutor = (request) => {
        if (request.command === "fake-opencode") {
          return { status: 0, signal: null, stdout: "fake-opencode 1.0\n", stderr: "", error: undefined } as SpawnSyncReturns<string>;
        }
        const result = real(request);
        if (request.cwd.includes("isolated-1-s2-consumer")
          && request.args.some((argument) => argument.includes("HIDDEN-SENTINEL"))) {
          return { ...result, status: 1, stdout: "", stderr: "isolated hidden miss" };
        }
        return result;
      };
      const prompts: Array<{ cwd: string; prompt: string }> = [];
      const consumerHistories: Array<{
        cwd: string;
        revList: string;
        refs: string;
        log: string;
        baseObjectStatus: number | null;
      }> = [];
      const executeOpenCode: OpenCodeProcessExecutor = async (request) => {
        const prompt = request.args.at(-1) ?? "";
        prompts.push({ cwd: request.cwd, prompt });
        const producer = prompt.includes("## Current Task\nImplement the first release handshake");
        if (producer) {
          rmSync(join(request.cwd, "decision.txt"));
        } else {
          consumerHistories.push({
            cwd: request.cwd,
            revList: git(request.cwd, ["rev-list", "--parents", "HEAD"]),
            refs: git(request.cwd, ["show-ref", "--head"]),
            log: git(request.cwd, ["log", "--all", "--root", "-p", "--format=fuller"]),
            baseObjectStatus: spawnSync(
              "git",
              ["cat-file", "-e", `${commit}^{commit}`],
              { cwd: request.cwd, encoding: "utf8", windowsHide: true },
            ).status,
          });
        }
        writeFileSync(join(request.cwd, "answer.txt"), `${producer ? "producer" : "consumer"}\n`, "utf8");
        const summary = producer
          ? "Implemented the first release handshake. The reusable release handshake repository convention is cyan-token."
          : "Implemented the next release handshake using the established repository convention.";
        const stdout = [
          { type: "text", part: { text: summary } },
          { type: "step_finish", part: { reason: "stop", tokens: { input: 20, output: 4 } } },
        ].map(JSON.stringify).join("\n");
        return {
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          durationMs: 5,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      };
      const report = await runCrossSessionEvaluation({
        manifest: manifest(base, commit),
        model: "test/model",
        repeat: 1,
        outputDirectory: output,
        repoMindRoot: process.cwd(),
        runnerExecutable: "fake-opencode",
        execute,
        executeOpenCode,
      });
      expect(report.runs.map((run) => `${run.arm}-${run.stageId}`)).toEqual([
        "isolated-producer", "isolated-consumer", "shared-producer", "shared-consumer",
      ]);
      expect(Math.max(...report.runs.map((run) => run.repository.length))).toBeGreaterThanOrEqual(181);
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      expect(report.acceptance.status).toBe("passed");
      expect(report.transfer).toMatchObject({
        sharedRecallRate: 1,
        isolatedRecallRate: 0,
        sharedHiddenPassRate: 1,
        isolatedHiddenPassRate: 0,
        sharedCommitRate: 1,
        isolatedCommitRate: 1,
      });
      expect(report.infrastructure).toEqual({
        stageRuns: 4,
        processAttempts: 4,
        retries: 0,
        retriedStageRuns: 0,
        exhaustedStageRuns: 0,
      });
      const derivedContext = renderHostContext({
        task: "Implement the derived-only consumer",
        memories: [],
        moduleNarratives: [{
          id: "narrative-derived",
          modulePath: "src",
          title: "Derived module contract",
          content: "Use the durable derived contract.",
          sourceCount: 1,
          sourceMemoryIds: [],
          budgetChars: 4_000,
          version: 2,
          current: true,
          createdAt: 1,
          updatedAt: 2,
        }],
        repositoryProfile: {
          id: "profile-derived",
          title: "Derived repository profile",
          content: "The current repository-level contract.",
          memorySourceCount: 1,
          moduleSourceCount: 1,
          sourceMemoryIds: [],
          sourceModuleNarrativeIds: [],
          budgetChars: 6_000,
          minConfidence: 0.8,
          version: 3,
          current: true,
          createdAt: 1,
          updatedAt: 2,
        },
      }).stats;
      const emptyContext = renderHostContext({
        task: "Implement the derived-only consumer",
        memories: [],
        moduleNarratives: [],
        repositoryProfile: undefined,
      }).stats;
      const derivedRuns = report.runs.map((run) => run.stageIndex === 0 ? run : ({
        ...run,
        maxMemories: 0,
        context: run.arm === "shared" ? derivedContext : emptyContext,
      }));
      const derivedExpected = [{
        sequenceId: "release-flow",
        stages: [{
          stageId: "producer",
          runner: "opencode" as const,
          model: "test/model",
          maxMemories: 5,
        }, {
          stageId: "consumer",
          runner: "opencode" as const,
          model: "test/model",
          maxMemories: 0,
        }],
      }];
      const derivedReport = buildCrossSessionReport({
        name: "derived-only telemetry",
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: derivedRuns,
        expected: derivedExpected,
        acceptanceCriteria: {
          minSharedDerivedRecallRate: 1,
          minSharedL2RecallRate: 1,
          minSharedL3RecallRate: 1,
          maxSharedDerivedStageL1RecallRate: 0,
          maxIsolatedDerivedRecallRate: 0,
        },
      });
      expect(derivedReport.integrity).toEqual({ passed: true, failures: [] });
      expect(derivedReport.derivedConsumption).toEqual({
        runsPerArm: 1,
        sharedDerivedRecallRate: 1,
        isolatedDerivedRecallRate: 0,
        sharedL1RecallRate: 0,
        isolatedL1RecallRate: 0,
        sharedL2RecallRate: 1,
        sharedL3RecallRate: 1,
      });
      expect(derivedReport.acceptance.status).toBe("passed");
      expect(derivedReport.acceptance.checks.filter((check) => !check.passed)).toEqual([]);
      const sharedConsumer = report.runs.find((run) => run.arm === "shared" && run.stageId === "consumer")!;
      const isolatedConsumer = report.runs.find((run) => run.arm === "isolated" && run.stageId === "consumer")!;
      expect(sharedConsumer.context.l1.injected).toBeGreaterThan(0);
      expect(isolatedConsumer.context).toMatchObject({
        l1: { injected: 0 },
        l2: { injected: 0 },
        l3: { injected: 0 },
      });
      expect(isolatedConsumer.lifecycle).toMatchObject({ status: "failed", commitSucceeded: true });
      expect(isolatedConsumer.quality).toMatchObject({
        status: "failed",
        authoritativeVerification: { passed: false },
      });
      expect(isolatedConsumer.maintenance).toBeNull();
      expect(sharedConsumer.lifecycle.retrievedMemoryIds.length).toBeGreaterThan(0);
      expect(new Set(report.runs.map((run) => run.projectId)).size).toBe(1);
      for (const arm of ["isolated", "shared"] as const) {
        const chain = report.runs.filter((run) => run.arm === arm);
        expect(chain[1]!.baseCommit).toBe(chain[0]!.checkpointCommit);
        expect(chain.every((run) => run.initialWorktreeClean)).toBe(true);
      }
      const promptFor = (repository: string): string => prompts.find(
        (entry) => realpathSync.native(entry.cwd) === realpathSync.native(repository),
      )!.prompt;
      expect(promptFor(sharedConsumer.repository)).toContain("cyan-token");
      expect(promptFor(isolatedConsumer.repository)).not.toContain("cyan-token");
      expect(consumerHistories).toHaveLength(2);
      for (const history of consumerHistories) {
        const commits = history.revList.split(/\r?\n/u).filter(Boolean);
        expect(commits).toHaveLength(1);
        expect(commits[0]!.trim().split(/\s+/u)).toHaveLength(1);
        expect(history.refs.split(/\r?\n/u)).toHaveLength(1);
        expect(history.refs).toMatch(/ HEAD$/u);
        expect(history.refs).not.toContain(commit);
        expect(history.refs).not.toContain("refs/");
        expect(history.log).not.toContain("cyan-token");
        expect(history.baseObjectStatus).not.toBe(0);
      }
      for (const run of report.runs) {
        expect(git(run.repository, ["log", "-1", "--format=%s"])).toBe("RepoMind cross-session snapshot");
        expect(git(run.repository, ["rev-list", "--parents", "HEAD"]).trim().split(/\s+/u)).toHaveLength(1);
        expect(git(run.repository, ["remote"])).toBe("");
        expect(existsSync(join(run.repository, ".git", "objects", "info", "alternates"))).toBe(false);
        expect(git(run.repository, ["reflog", "show", "--all"])).toBe("");
        expect(git(run.repository, ["fsck", "--unreachable", "--no-reflogs"])).toBe("");
        expect(spawnSync(
          "git",
          ["cat-file", "-e", `${run.baseCommit}^{commit}`],
          { cwd: run.repository, encoding: "utf8", windowsHide: true },
        ).status).not.toBe(0);
      }
      const core = new RepositoryMemoryCore(sharedConsumer.repository, { dataDirectory: sharedConsumer.dataDirectory });
      try {
        const leaked = core.context.database.raw.prepare(
          "SELECT count(*) AS count FROM evidence WHERE content LIKE '%HIDDEN-SENTINEL%'",
        ).get() as { count: number };
        expect(Number(leaked.count)).toBe(0);
      } finally {
        core.close();
      }
      const serialized = readFileSync(join(output, "summary.json"), "utf8");
      expect(serialized).not.toContain("cyan-token");
      expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("cross-session learning benchmark");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an out-of-scope self-committed change before checkpointing or cross-session learning", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-cross-scope-gate-"));
    const base = join(root, "base");
    const output = join(root, "output");
    try {
      spawnSync("git", ["init", "-q", base], { encoding: "utf8", windowsHide: true });
      writeFileSync(join(base, "answer.txt"), "base\n", "utf8");
      git(base, ["add", "."]);
      git(base, ["-c", "user.name=RepoMind", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
      const commit = git(base, ["rev-parse", "HEAD"]);
      const real: CrossSessionProcessExecutor = (request) => spawnSync(request.command, request.args, {
        cwd: request.cwd,
        encoding: "utf8",
        timeout: request.timeoutMs,
        windowsHide: true,
        shell: false,
      });
      let checkCalls = 0;
      const execute: CrossSessionProcessExecutor = (request) => {
        if (request.command === process.execPath) checkCalls += 1;
        return real(request);
      };
      let agentRuns = 0;
      const adapter: AgentHostAdapter<"opencode"> = {
        id: "opencode",
        displayName: "scope fixture",
        executable: "scope-fixture",
        validate: () => undefined,
        version: async () => "scope fixture 1.0",
        run: async (request) => {
          agentRuns += 1;
          writeFileSync(join(request.repository, "answer.txt"), "producer\n", "utf8");
          writeFileSync(join(request.repository, "rogue.txt"), "must not cross the stage boundary\n", "utf8");
          git(request.repository, ["add", "answer.txt", "rogue.txt"]);
          git(request.repository, [
            "-c", "user.name=Agent",
            "-c", "user.email=agent@example.com",
            "commit", "-q", "-m", "agent self-commit",
          ]);
          return {
            process: {
              exitCode: 0,
              signal: null,
              stdout: "scope fixture event stream\n",
              stderr: "",
              durationMs: 5,
              timedOut: false,
              aborted: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
            outcome: {
              summary: "Implemented the producer task and recorded its reusable convention.",
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
        },
      };

      await expect(runCrossSessionEvaluation({
        manifest: manifest(base, commit),
        model: "test/model",
        repeat: 1,
        outputDirectory: output,
        repoMindRoot: process.cwd(),
        execute,
        adapterFactory: () => adapter,
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining(
          "release-flow/isolated/1/producer: changed files outside allowedChanges: rogue.txt",
        ),
        details: expect.objectContaining({
          changedFiles: ["answer.txt", "rogue.txt"],
          unexpectedChanges: ["rogue.txt"],
          allowedChanges: ["answer.txt", "decision.txt"],
        }),
      });

      const name = "release-flow-isolated-1-s1-producer";
      const repository = join(output, "runs", name);
      const dataDirectory = join(output, "data", "release-flow-1-isolated-s1");
      const reportPath = join(output, "artifacts", name, "run.json");
      expect(agentRuns).toBe(1);
      expect(checkCalls).toBe(0);
      expect(existsSync(join(output, "summary.json"))).toBe(false);
      expect(existsSync(reportPath)).toBe(true);
      expect(git(repository, ["log", "--format=%s"])).not.toContain("RepoMind cross-session checkpoint");
      expect(git(repository, ["status", "--short"])).toBe("");
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
        session: { status: "failed" },
        quality: {
          status: "failed",
          authoritativeVerification: { authority: "benchmark-manifest", checks: 1, passed: false },
        },
        commit: { status: "failed", memories: { stored: 0 } },
        maintenance: null,
      });

      const core = new RepositoryMemoryCore(repository, { dataDirectory });
      try {
        expect(core.listSessions()).toEqual([expect.objectContaining({ status: "failed" })]);
        expect(core.listHostRuns()).toEqual([expect.objectContaining({ status: "failed" })]);
        expect(core.status()).toMatchObject({
          memories: 0,
          moduleNarratives: 0,
          repositoryProfiles: 0,
          skillCandidates: 0,
          openSessions: 0,
          runningHostRuns: 0,
        });
        const persistedChecks = core.context.database.raw.prepare(
          "SELECT count(*) AS count FROM evidence WHERE kind='test_result'",
        ).get() as { count: number };
        expect(Number(persistedChecks.count)).toBe(0);
      } finally {
        core.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs paired Claude-to-OpenCode and OpenCode-to-Claude transfer stages", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-cross-agent-eval-"));
    const base = join(root, "base");
    const output = join(root, "output");
    try {
      spawnSync("git", ["init", "-q", base], { encoding: "utf8", windowsHide: true });
      writeFileSync(join(base, "answer.txt"), "base\n", "utf8");
      git(base, ["add", "."]);
      git(base, ["-c", "user.name=RepoMind", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
      const commit = git(base, ["rev-parse", "HEAD"]);
      const stage = (
        id: string,
        runner: CrossSessionRunner,
        model: string,
        expected: "producer" | "consumer",
      ) => ({
        id,
        runner,
        model,
        prompt: expected === "producer"
          ? `PRODUCER_TASK ${id}\nImplement the first release handshake and establish its repository convention.`
          : `CONSUMER_TASK ${id}\nImplement the next release handshake by reusing the repository convention from the earlier task.`,
        publicChecks: [answerCheck(expected)],
        hiddenChecks: [answerCheck(expected, true)],
        allowedChanges: ["answer.txt"],
      });
      const experiment = parseCrossSessionManifest({
        version: 1,
        name: "bidirectional cross-agent transfer",
        acceptance: {
          minSharedTransferHiddenPassRate: 1,
          minTransferHiddenPassRateDelta: 0,
          minSharedRecallRate: 1,
          maxIsolatedRecallRate: 0,
          minSharedCommitRate: 1,
          maxMeanTotalPromptTokenRegressionPercent: 0,
          minTotalPromptTokenPairedWinRate: 1,
          minAgentDurationPairedWinRate: 1,
        },
        sequences: [{
          id: "claude-to-opencode",
          baseRepository: base,
          baseCommit: commit,
          stages: [
            stage("producer", "claude", "claude/test", "producer"),
            stage("consumer", "opencode", "opencode/test", "consumer"),
          ],
        }, {
          id: "opencode-to-claude",
          baseRepository: base,
          baseCommit: commit,
          stages: [
            stage("producer", "opencode", "opencode/test", "producer"),
            stage("consumer", "claude", "claude/test", "consumer"),
          ],
        }],
      });
      const real: CrossSessionProcessExecutor = (request) => spawnSync(request.command, request.args, {
        cwd: request.cwd,
        encoding: "utf8",
        timeout: request.timeoutMs,
        windowsHide: true,
        shell: false,
      });
      const calls: Array<{ runner: CrossSessionRunner; model: string | null; prompt: string }> = [];
      const report = await runCrossSessionEvaluation({
        manifest: experiment,
        model: "default/model",
        repeat: 1,
        outputDirectory: output,
        repoMindRoot: process.cwd(),
        execute: real,
        adapterFactory: (runner) => mixedAdapter(runner, calls),
      });

      expect(report.version).toBe(4);
      expect(report.runner).toBe("mixed");
      expect(report.model).toBe("mixed");
      expect(report.provenance.runnerVersions).toEqual({
        claude: "claude fixture 1.0",
        opencode: "opencode fixture 1.0",
      });
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      expect(report.infrastructure).toEqual({
        stageRuns: 8,
        processAttempts: 8,
        retries: 0,
        retriedStageRuns: 0,
        exhaustedStageRuns: 0,
      });
      expect(report.acceptance.checks.filter((check) => !check.passed)).toEqual([]);
      expect(report.acceptance.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "comparablePairCoverageRate", passed: true, measured: 1 }),
        expect.objectContaining({ id: "meanTotalPromptTokenRegressionPercent", passed: true, measured: -50 }),
        expect.objectContaining({ id: "totalPromptTokenPairedWinRate", passed: true, measured: 1 }),
        expect.objectContaining({ id: "agentDurationPairedWinRate", passed: true, measured: 1 }),
      ]));
      expect(report.efficiencyCoverage).toEqual({
        totalPairs: 2,
        eligiblePairs: 2,
        excludedPairs: 0,
        rate: 1,
      });
      const stageRunners = Object.fromEntries(report.runs
        .filter((run) => run.arm === "shared")
        .map((run) => [`${run.sequenceId}/${run.stageId}`, `${run.runner}/${run.model}`]));
      expect(stageRunners).toEqual({
        "claude-to-opencode/producer": "claude/claude/test",
        "claude-to-opencode/consumer": "opencode/opencode/test",
        "opencode-to-claude/producer": "opencode/opencode/test",
        "opencode-to-claude/consumer": "claude/claude/test",
      });
      expect(calls).toHaveLength(8);
      for (const sequenceId of ["claude-to-opencode", "opencode-to-claude"]) {
        const producers = report.runs.filter((run) => run.sequenceId === sequenceId && run.stageIndex === 0);
        expect(producers).toHaveLength(2);
        expect(producers[0]!.checkpointTree).toMatch(/^[a-f0-9]{40}$/u);
        expect(producers[0]!.checkpointTree).toBe(producers[1]!.checkpointTree);
      }
      const inputTokens = report.comparison.find((metric) => metric.key === "inputTokens")!;
      const cacheWriteTokens = report.comparison.find((metric) => metric.key === "cacheWriteTokens")!;
      const totalPromptTokens = report.comparison.find((metric) => metric.key === "totalPromptTokens")!;
      const duration = report.comparison.find((metric) => metric.key === "agentDurationMs")!;
      expect(inputTokens).toMatchObject({ pairs: 2, sharedWins: 2, sharedLosses: 0 });
      expect(cacheWriteTokens).toMatchObject({ pairs: 2, isolatedMean: 0, sharedMean: 0 });
      expect(totalPromptTokens).toMatchObject({ pairs: 2, sharedWins: 2, sharedLosses: 0 });
      expect(duration).toMatchObject({ pairs: 2, sharedWins: 2, sharedLosses: 0 });
      const markdown = readFileSync(join(output, "summary.md"), "utf8");
      expect(markdown).toContain("| Total pairs | Eligible efficiency pairs | Excluded pairs | Comparable coverage |");
      expect(markdown).toContain("Report schema: v4");
      expect(markdown).toContain("Input/cache-read/cache-write tokens");

      const fasterFailedSharedRuns = report.runs.map((run) => {
        if (run.sequenceId !== "claude-to-opencode" || run.arm !== "shared" || run.stageIndex === 0) return run;
        return {
          ...run,
          hiddenChecks: run.hiddenChecks.map((check) => ({ ...check, exitCode: 1, passed: false })),
          lifecycle: {
            ...run.lifecycle,
            status: "failed" as const,
            agentMs: 0,
            maintenanceMs: null,
            hostLifecycleMs: 0,
          },
          quality: {
            ...run.quality,
            completion: "failed" as const,
            status: "failed" as const,
            maintenanceEligible: false,
            qualityFlags: ["authoritative-verification-failed" as const],
            authoritativeVerification: { ...run.quality.authoritativeVerification, passed: false },
          },
          maintenance: null,
          events: {
            ...run.events,
            tokens: { ...run.events.tokens, input: 0, output: 0 },
            fileReads: 0,
          },
        };
      });
      const expected = experiment.sequences.map((sequence) => ({
        sequenceId: sequence.id,
        stages: sequence.stages.map((configuredStage) => ({
          stageId: configuredStage.id,
          runner: configuredStage.runner!,
          model: configuredStage.model!,
        })),
      }));
      const fasterFailure = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: fasterFailedSharedRuns,
        expected,
        acceptanceCriteria: {
          minInputTokenPairedWinRate: 1,
          minAgentDurationPairedWinRate: 1,
        },
      });
      expect(fasterFailure.integrity).toEqual({ passed: true, failures: [] });
      expect(fasterFailure.efficiencyCoverage).toEqual({
        totalPairs: 2,
        eligiblePairs: 1,
        excludedPairs: 1,
        rate: 0.5,
      });
      for (const key of ["hostLifecycleMs", "agentDurationMs", "inputTokens", "totalPromptTokens", "outputTokens", "fileReads"] as const) {
        expect(fasterFailure.comparison.find((metric) => metric.key === key)?.pairs).toBe(1);
      }
      for (const key of ["hiddenSuccess", "publicSuccess", "processAttempts", "cacheReadTokens", "cacheWriteTokens", "retrievedRecords", "contextChars"] as const) {
        expect(fasterFailure.comparison.find((metric) => metric.key === key)?.pairs).toBe(2);
      }
      expect(fasterFailure.comparison.find((metric) => metric.key === "hiddenSuccess"))
        .toMatchObject({ isolatedMean: 1, sharedMean: 0.5 });
      expect(fasterFailure.comparison.find((metric) => metric.key === "inputTokens"))
        .toMatchObject({ pairs: 1, sharedWins: 1 });
      expect(fasterFailure.acceptance.status).toBe("failed");
      expect(fasterFailure.acceptance.checks).toContainEqual(expect.objectContaining({
        id: "comparablePairCoverageRate",
        passed: false,
        measured: 0.5,
        target: ">= 0.8",
      }));
      const relaxedCoverage = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: fasterFailedSharedRuns,
        expected,
        acceptanceCriteria: {
          minInputTokenPairedWinRate: 1,
          minAgentDurationPairedWinRate: 1,
          minComparablePairCoverageRate: 0.5,
        },
      });
      expect(relaxedCoverage.acceptance.status).toBe("passed");
      expect(relaxedCoverage.acceptance.checks).toContainEqual(expect.objectContaining({
        id: "comparablePairCoverageRate",
        passed: true,
        target: ">= 0.5",
      }));

      const cacheReversalRuns = report.runs.map((run) => run.stageIndex === 0 ? run : ({
        ...run,
        events: {
          ...run.events,
          tokens: run.arm === "isolated"
            ? { ...run.events.tokens, input: 100, cacheRead: 0, cacheWrite: 0 }
            : { ...run.events.tokens, input: 50, cacheRead: 60, cacheWrite: 5 },
        },
      }));
      const cacheReversal = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: cacheReversalRuns,
        expected,
        acceptanceCriteria: {
          maxMeanTotalPromptTokenRegressionPercent: 0,
          minTotalPromptTokenPairedWinRate: 1,
        },
      });
      expect(cacheReversal.comparison.find((metric) => metric.key === "inputTokens"))
        .toMatchObject({ pairs: 2, isolatedMean: 100, sharedMean: 50, sharedWins: 2 });
      expect(cacheReversal.comparison.find((metric) => metric.key === "cacheWriteTokens"))
        .toMatchObject({ pairs: 2, isolatedMean: 0, sharedMean: 5 });
      expect(cacheReversal.comparison.find((metric) => metric.key === "totalPromptTokens"))
        .toMatchObject({ pairs: 2, isolatedMean: 100, sharedMean: 115, sharedLosses: 2, relativeDeltaPercent: 15 });
      expect(cacheReversal.acceptance.status).toBe("failed");
      expect(cacheReversal.acceptance.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "comparablePairCoverageRate", passed: true, measured: 1 }),
        expect.objectContaining({ id: "meanTotalPromptTokenRegressionPercent", passed: false, measured: 15 }),
        expect.objectContaining({ id: "totalPromptTokenPairedWinRate", passed: false, measured: 0 }),
      ]));

      const legacyRawInputGate = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: cacheReversalRuns,
        expected,
        acceptanceCriteria: {
          maxMeanInputTokenRegressionPercent: 0,
          minInputTokenPairedWinRate: 1,
        },
      });
      expect(legacyRawInputGate.acceptance.status).toBe("passed");
      expect(legacyRawInputGate.acceptance.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "meanInputTokenRegressionPercent", passed: true, measured: -50 }),
        expect.objectContaining({ id: "inputTokenPairedWinRate", passed: true, measured: 1 }),
      ]));

      const emptyChecks = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: report.runs.map((run) =>
          run.sequenceId === "claude-to-opencode" && run.arm === "shared" && run.stageIndex > 0
            ? { ...run, hiddenChecks: [] }
            : run),
        expected,
      });
      expect(emptyChecks.transfer.sharedHiddenPassRate).toBe(0.5);
      expect(emptyChecks.comparison.find((metric) => metric.key === "hiddenSuccess"))
        .toMatchObject({ pairs: 2, sharedMean: 0.5 });
      expect(emptyChecks.efficiencyCoverage).toMatchObject({ eligiblePairs: 1, excludedPairs: 1, rate: 0.5 });

      const corruptedRuns = report.runs.map((run) => {
        if (run.sequenceId === "claude-to-opencode" && run.arm === "isolated" && run.stageIndex === 0) {
          return {
            ...run,
            checkpointTree: "0".repeat(40),
            hiddenChecks: run.hiddenChecks.map((check, index) => index === 0 ? { ...check, passed: false } : check),
          };
        }
        if (run.sequenceId === "opencode-to-claude" && run.arm === "shared" && run.stageId === "consumer") {
          return { ...run, runner: "opencode" as const };
        }
        return run;
      });
      const corrupted = buildCrossSessionReport({
        name: experiment.name,
        repeat: 1,
        outputDirectory: output,
        provenance: report.provenance,
        runs: corruptedRuns,
        expected,
        acceptanceCriteria: { minSharedRecallRate: 0 },
      });
      expect(corrupted.integrity.failures).toEqual(expect.arrayContaining([
        expect.stringContaining("producer hidden checks did not all pass"),
        expect.stringContaining("producer checkpoint trees differ across arms"),
        expect.stringContaining("paired runner/model differ across arms"),
      ]));
      expect(corrupted.acceptance.status).toBe("failed");
      expect(corrupted.acceptance.checks).toContainEqual(expect.objectContaining({
        id: "integrity",
        passed: false,
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
