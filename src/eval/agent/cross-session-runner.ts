import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import type { TestEvidenceInput } from "../../domain/types.js";
import { RepoMindError } from "../../errors.js";
import { runAgentHost } from "../../integrations/agent-host/run.js";
import {
  createAgentHostAdapter,
  type AgentHostAdapterFactoryOptions,
} from "../../integrations/agent-host/registry.js";
import type { AgentHostAdapter } from "../../integrations/agent-host/types.js";
import type { OpenCodeProcessExecutor } from "../../integrations/opencode/run.js";
import { VERSION } from "../../version.js";
import type {
  CrossSessionCheck,
  CrossSessionManifest,
  CrossSessionRunner,
  CrossSessionSequence,
  CrossSessionStage,
} from "./cross-session-manifest.js";
import {
  buildCrossSessionReport,
  renderCrossSessionMarkdown,
  type CrossSessionArm,
  type CrossSessionEvalReport,
  type CrossSessionMemoryState,
  type CrossSessionStageRun,
} from "./cross-session-report.js";
import type { CheckResult } from "./report.js";

export interface CrossSessionProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export type CrossSessionProcessExecutor = (
  request: CrossSessionProcessRequest,
) => SpawnSyncReturns<string>;

export type CrossSessionAdapterFactory = (
  runner: CrossSessionRunner,
  options: AgentHostAdapterFactoryOptions,
) => AgentHostAdapter;

export interface RunCrossSessionEvaluationOptions {
  manifest: CrossSessionManifest;
  runner?: CrossSessionRunner;
  model: string;
  repeat: number;
  outputDirectory: string;
  repoMindRoot: string;
  runnerExecutable?: string;
  manifestSha256?: string;
  timeoutMs?: number;
  maxMemories?: number;
  contextBudgetChars?: number;
  execute?: CrossSessionProcessExecutor;
  executeOpenCode?: OpenCodeProcessExecutor;
  adapterFactory?: CrossSessionAdapterFactory;
}

const defaultExecutor: CrossSessionProcessExecutor = ({ command, args, cwd, timeoutMs }) => spawnSync(
  command,
  args,
  {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  },
);

interface ResolvedStageAgent {
  runner: CrossSessionRunner;
  model: string;
}

const stageAgentKey = (sequenceId: string, stageId: string): string => `${sequenceId}\0${stageId}`;

function resolveStageAgents(
  manifest: CrossSessionManifest,
  defaultRunner: CrossSessionRunner,
  defaultModel: string,
): Map<string, ResolvedStageAgent> {
  if (!defaultModel.trim()) throw new RepoMindError("INVALID_INPUT", "Cross-session default model must not be empty");
  const resolved = new Map<string, ResolvedStageAgent>();
  for (const sequence of manifest.sequences) {
    let previousRunner = defaultRunner;
    for (const stage of sequence.stages) {
      const runner = stage.runner ?? defaultRunner;
      if (runner !== previousRunner && stage.model === undefined) {
        throw new RepoMindError(
          "INVALID_INPUT",
          `Cross-session stage ${sequence.id}/${stage.id} switches runner from ${previousRunner} to ${runner} and requires an explicit model`,
        );
      }
      resolved.set(stageAgentKey(sequence.id, stage.id), {
        runner,
        model: stage.model ?? defaultModel,
      });
      previousRunner = runner;
    }
  }
  return resolved;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function requireRawSuccess(result: SpawnSyncReturns<string>, description: string): string {
  if (result.error || result.status !== 0) {
    throw new RepoMindError("INVALID_INPUT", `${description} failed`, {
      cause: result.error?.message ?? result.stderr ?? result.stdout,
      exitCode: result.status,
    });
  }
  return result.stdout;
}

function requireSuccess(result: SpawnSyncReturns<string>, description: string): string {
  return requireRawSuccess(result, description).trim();
}

function replaceRepository(value: string, repository: string): string {
  return value.replaceAll("{repo}", repository);
}

function runChecks(
  checks: readonly CrossSessionCheck[],
  repository: string,
  execute: CrossSessionProcessExecutor,
): CheckResult[] {
  return checks.map((check) => {
    const started = performance.now();
    const command = replaceRepository(check.command, repository);
    const args = check.args.map((argument) => replaceRepository(argument, repository));
    const result = execute({
      command,
      args,
      cwd: repository,
      timeoutMs: check.timeoutMs ?? 60_000,
    });
    return {
      command,
      args,
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
      durationMs: round(performance.now() - started),
      passed: result.status === 0 && !result.error,
    };
  });
}

function checkEvidence(check: CheckResult): TestEvidenceInput {
  const command = [check.command, ...check.args].map((value) => JSON.stringify(value)).join(" ");
  const output = [check.stdout.trim(), check.stderr.trim()].filter(Boolean).join("\n");
  const fallback = check.exitCode === null
    ? "Benchmark check could not be executed."
    : check.passed ? "Benchmark check passed." : "Benchmark check failed.";
  return {
    command,
    exitCode: check.exitCode ?? 1,
    summary: (output || fallback).slice(0, 2_000),
  };
}

interface StageChangeSet {
  changedFiles: string[];
  unexpectedChanges: string[];
}

function nulSeparatedPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function inspectStageChanges(input: {
  repository: string;
  baseCommit: string;
  allowedChanges: readonly string[] | undefined;
  sequenceId: string;
  stageId: string;
  execute: CrossSessionProcessExecutor;
}): StageChangeSet {
  const tracked = requireRawSuccess(input.execute({
    command: "git",
    args: ["diff", "--name-only", "--no-renames", "-z", input.baseCommit, "--"],
    cwd: input.repository,
    timeoutMs: 30_000,
  }), `Inspect tracked changes for ${input.sequenceId}/${input.stageId}`);
  const untracked = requireRawSuccess(input.execute({
    command: "git",
    args: ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd: input.repository,
    timeoutMs: 30_000,
  }), `Inspect untracked changes for ${input.sequenceId}/${input.stageId}`);
  const changedFiles = [...new Set([
    ...nulSeparatedPaths(tracked),
    ...nulSeparatedPaths(untracked),
  ])].sort((left, right) => left.localeCompare(right));
  const allowed = input.allowedChanges === undefined ? null : new Set(input.allowedChanges);
  return {
    changedFiles,
    unexpectedChanges: allowed === null ? [] : changedFiles.filter((path) => !allowed.has(path)),
  };
}

function allowedChangesCheck(
  changes: StageChangeSet,
  durationMs: number,
): CheckResult {
  const passed = changes.unexpectedChanges.length === 0;
  return {
    command: "repomind:allowed-changes",
    args: [],
    exitCode: passed ? 0 : 1,
    signal: null,
    stdout: passed
      ? `Changed files are within the stage allowlist: ${changes.changedFiles.join(", ") || "none"}`
      : "",
    stderr: passed
      ? ""
      : `Files outside the stage allowlist: ${changes.unexpectedChanges.join(", ")}`,
    durationMs,
    passed,
  };
}

function stageScopeViolation(input: {
  sequenceId: string;
  arm: CrossSessionArm;
  iteration: number;
  stageId: string;
  changes: StageChangeSet;
  allowedChanges: readonly string[];
  reportPath: string;
}): RepoMindError {
  const label = `${input.sequenceId}/${input.arm}/${input.iteration}/${input.stageId}`;
  return new RepoMindError(
    "INVALID_INPUT",
    `${label}: changed files outside allowedChanges: ${input.changes.unexpectedChanges.join(", ")}`,
    {
      changedFiles: input.changes.changedFiles,
      unexpectedChanges: input.changes.unexpectedChanges,
      allowedChanges: [...input.allowedChanges],
      reportPath: input.reportPath,
    },
  );
}

function writeProjectMarker(repository: string, projectId: string, name: string): void {
  const markerDirectory = join(repository, ".repomind");
  mkdirSync(markerDirectory, { recursive: true });
  writeFileSync(join(markerDirectory, "project.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    name,
  }, null, 2)}\n`, "utf8");
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RepoMindError("STORAGE_UNAVAILABLE", `RepoMind status field ${field} is unavailable`);
  }
  return value;
}

function memoryState(repository: string, dataDirectory: string): CrossSessionMemoryState {
  const core = new RepositoryMemoryCore(repository, { dataDirectory });
  try {
    const status = core.status();
    return {
      sessions: number(status.sessions, "sessions"),
      evidence: number(status.evidence, "evidence"),
      memories: number(status.memories, "memories"),
      moduleNarratives: number(status.moduleNarratives, "moduleNarratives"),
      repositoryProfiles: number(status.repositoryProfiles, "repositoryProfiles"),
      skillCandidates: number(status.skillCandidates, "skillCandidates"),
      openSessions: number(status.openSessions, "openSessions"),
      runningHostRuns: number(status.runningHostRuns, "runningHostRuns"),
    };
  } finally {
    core.close();
  }
}

function prepareOutputDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length) {
    throw new RepoMindError("INVALID_INPUT", `Cross-session output directory is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

function cloneStage(input: {
  sequence: CrossSessionSequence;
  sourceRepository: string;
  sourceCommit: string;
  repository: string;
  projectId: string;
  execute: CrossSessionProcessExecutor;
}): { requestedCommit: string; baseCommit: string; initialWorktreeClean: boolean } {
  if (existsSync(input.repository)) {
    throw new RepoMindError("INVALID_INPUT", `Cross-session run directory already exists: ${input.repository}`);
  }
  mkdirSync(input.repository, { recursive: true });
  requireSuccess(input.execute({
    command: "git",
    args: ["init", "--quiet"],
    cwd: input.repository,
    timeoutMs: 30_000,
  }), `Initialize ${input.sequence.id}`);
  requireSuccess(input.execute({
    command: "git",
    args: ["fetch", "--quiet", "--no-tags", input.sourceRepository, input.sourceCommit],
    cwd: input.repository,
    timeoutMs: 120_000,
  }), `Fetch ${input.sequence.id}`);
  requireSuccess(input.execute({
    command: "git",
    args: ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    cwd: input.repository,
    timeoutMs: 60_000,
  }), `Checkout ${input.sequence.id}`);
  const requestedCommit = requireSuccess(input.execute({
    command: "git", args: ["rev-parse", "FETCH_HEAD"], cwd: input.repository, timeoutMs: 30_000,
  }), `Resolve stage commit for ${input.sequence.id}`);
  const baseCommit = requireSuccess(input.execute({
    command: "git", args: ["rev-parse", "HEAD"], cwd: input.repository, timeoutMs: 30_000,
  }), `Inspect stage commit for ${input.sequence.id}`);
  rmSync(join(input.repository, ".git", "FETCH_HEAD"), { force: true });
  appendFileSync(join(input.repository, ".git", "info", "exclude"), "\n.repomind/\nopencode.json\n", "utf8");
  writeProjectMarker(input.repository, input.projectId, input.sequence.id);
  const status = requireSuccess(input.execute({
    command: "git", args: ["status", "--porcelain"], cwd: input.repository, timeoutMs: 30_000,
  }), `Inspect initial stage worktree for ${input.sequence.id}`);
  return { requestedCommit, baseCommit, initialWorktreeClean: status.length === 0 };
}

function checkpoint(
  repository: string,
  sequenceId: string,
  stage: CrossSessionStage,
  execute: CrossSessionProcessExecutor,
): { commit: string; tree: string } {
  requireSuccess(execute({
    command: "git", args: ["add", "--all"], cwd: repository, timeoutMs: 30_000,
  }), `Stage changes ${sequenceId}/${stage.id}`);
  const tree = requireSuccess(execute({
    command: "git", args: ["write-tree"], cwd: repository, timeoutMs: 30_000,
  }), `Write checkpoint tree ${sequenceId}/${stage.id}`);
  const previousHead = requireSuccess(execute({
    command: "git", args: ["rev-parse", "HEAD"], cwd: repository, timeoutMs: 30_000,
  }), `Inspect pre-checkpoint HEAD ${sequenceId}/${stage.id}`);
  const commit = requireSuccess(execute({
    command: "git",
    args: [
      "-c", "user.name=RepoMind-Eval",
      "-c", "user.email=eval@repomind.local",
      "commit-tree", tree, "-m", "RepoMind cross-session snapshot",
    ],
    cwd: repository,
    timeoutMs: 60_000,
  }), `Checkpoint ${sequenceId}/${stage.id}`);
  requireSuccess(execute({
    command: "git",
    args: ["update-ref", "--no-deref", "HEAD", commit, previousHead],
    cwd: repository,
    timeoutMs: 30_000,
  }), `Detach checkpoint HEAD ${sequenceId}/${stage.id}`);
  const refs = requireSuccess(execute({
    command: "git", args: ["for-each-ref", "--format=%(refname)"], cwd: repository, timeoutMs: 30_000,
  }), `Inspect checkpoint refs ${sequenceId}/${stage.id}`).split(/\r?\n/u).filter(Boolean);
  for (const ref of refs) {
    requireSuccess(execute({
      command: "git", args: ["update-ref", "--no-deref", "-d", ref], cwd: repository, timeoutMs: 30_000,
    }), `Remove inherited ref ${ref} for ${sequenceId}/${stage.id}`);
  }
  requireSuccess(execute({
    command: "git",
    args: ["update-ref", "refs/heads/repomind-stage-snapshot", commit],
    cwd: repository,
    timeoutMs: 30_000,
  }), `Publish checkpoint snapshot ${sequenceId}/${stage.id}`);
  requireSuccess(execute({
    command: "git",
    args: ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"],
    cwd: repository,
    timeoutMs: 30_000,
  }), `Expire checkpoint reflogs ${sequenceId}/${stage.id}`);
  requireSuccess(execute({
    command: "git",
    args: ["-c", "core.longpaths=true", "gc", "--quiet", "--prune=now"],
    cwd: repository,
    timeoutMs: 120_000,
  }), `Prune inherited objects ${sequenceId}/${stage.id}`);
  return { commit, tree };
}

async function executeStage(input: {
  sequence: CrossSessionSequence;
  stage: CrossSessionStage;
  stageIndex: number;
  arm: CrossSessionArm;
  iteration: number;
  projectId: string;
  sourceRepository: string;
  sourceCommit: string;
  previousCheckpointCommit: string | null;
  dataDirectory: string;
  options: RunCrossSessionEvaluationOptions;
  outputDirectory: string;
  runner: CrossSessionRunner;
  model: string;
  adapter: AgentHostAdapter;
  execute: CrossSessionProcessExecutor;
}): Promise<CrossSessionStageRun> {
  const name = `${input.sequence.id}-${input.arm}-${input.iteration}-s${input.stageIndex + 1}-${input.stage.id}`;
  const repository = join(input.outputDirectory, "runs", name);
  const cloned = cloneStage({
    sequence: input.sequence,
    sourceRepository: input.sourceRepository,
    sourceCommit: input.sourceCommit,
    repository,
    projectId: input.projectId,
    execute: input.execute,
  });
  let publicChecks: CheckResult[] = [];
  let hiddenChecks: CheckResult[] = [];
  let verificationMs = 0;
  const host = await runAgentHost({
    adapter: input.adapter,
    repository,
    task: input.stage.prompt,
    model: input.model,
    dataDirectory: input.dataDirectory,
    outputDirectory: join(input.outputDirectory, "artifacts", name),
    timeoutMs: input.options.timeoutMs ?? 600_000,
    maxMemories: input.stage.maxMemories ?? input.options.maxMemories ?? 5,
    ...(input.options.contextBudgetChars === undefined ? {} : {
      contextBudgetChars: input.options.contextBudgetChars,
    }),
    verificationAuthority: "benchmark-manifest",
    verify: () => {
      const started = performance.now();
      const scopeCheck = input.stage.allowedChanges === undefined ? null : (() => {
        const scopeStarted = performance.now();
        const changes = inspectStageChanges({
          repository,
          baseCommit: cloned.baseCommit,
          allowedChanges: input.stage.allowedChanges,
          sequenceId: input.sequence.id,
          stageId: input.stage.id,
          execute: input.execute,
        });
        return allowedChangesCheck(changes, round(performance.now() - scopeStarted));
      })();
      if (scopeCheck && !scopeCheck.passed) {
        publicChecks = [scopeCheck];
        hiddenChecks = [];
        verificationMs = round(performance.now() - started);
        return { checks: [checkEvidence(scopeCheck)], evidence: [] };
      }
      const persistedPublicChecks = runChecks(input.stage.publicChecks, repository, input.execute);
      publicChecks = [...(scopeCheck ? [scopeCheck] : []), ...persistedPublicChecks];
      hiddenChecks = runChecks(input.stage.hiddenChecks, repository, input.execute);
      verificationMs = round(performance.now() - started);
      return {
        checks: [...publicChecks, ...hiddenChecks].map(checkEvidence),
        evidence: persistedPublicChecks.map(checkEvidence),
      };
    },
  });
  const changes = inspectStageChanges({
    repository,
    baseCommit: cloned.baseCommit,
    allowedChanges: input.stage.allowedChanges,
    sequenceId: input.sequence.id,
    stageId: input.stage.id,
    execute: input.execute,
  });
  if (input.stage.allowedChanges !== undefined && changes.unexpectedChanges.length > 0) {
    throw stageScopeViolation({
      sequenceId: input.sequence.id,
      arm: input.arm,
      iteration: input.iteration,
      stageId: input.stage.id,
      changes,
      allowedChanges: input.stage.allowedChanges,
      reportPath: host.artifacts.report,
    });
  }
  const checkpointResult = checkpoint(repository, input.sequence.id, input.stage, input.execute);
  const hostLifecycleMs = round(
    host.session.startMs
    + host.agent.durationMs
    + (host.session.commitMs ?? 0)
    + (host.session.maintenanceMs ?? 0)
    + (host.session.abandonMs ?? 0),
  );
  return {
    sequenceId: input.sequence.id,
    arm: input.arm,
    iteration: input.iteration,
    stageId: input.stage.id,
    stageIndex: input.stageIndex,
    maxMemories: input.stage.maxMemories ?? input.options.maxMemories ?? 5,
    runner: input.runner,
    model: input.model,
    repository,
    dataDirectory: input.dataDirectory,
    projectId: input.projectId,
    requestedCommit: cloned.requestedCommit,
    baseCommit: cloned.baseCommit,
    previousCheckpointCommit: input.previousCheckpointCommit,
    checkpointCommit: checkpointResult.commit,
    checkpointTree: checkpointResult.tree,
    initialWorktreeClean: cloned.initialWorktreeClean,
    changedFiles: changes.changedFiles,
    unexpectedChanges: changes.unexpectedChanges,
    publicChecks,
    hiddenChecks,
    verificationMs,
    lifecycle: {
      sessionId: host.session.id,
      status: host.session.status,
      startMs: host.session.startMs,
      agentMs: host.agent.durationMs,
      commitMs: host.session.commitMs,
      commitSucceeded: host.commit !== null,
      maintenanceMs: host.session.maintenanceMs,
      hostLifecycleMs,
      retrievedMemoryIds: host.session.retrievedMemoryIds,
      retrievedModuleNarrativeIds: host.session.retrievedModuleNarrativeIds,
      repositoryProfileId: host.session.repositoryProfileId,
    },
    context: host.context,
    quality: host.quality,
    maintenance: host.maintenance,
    memoryState: memoryState(repository, input.dataDirectory),
    events: host.agent.events,
    artifacts: host.artifacts,
    agent: {
      attempts: host.retry.attempts,
      infrastructureRetries: host.retry.retries,
      retryExhausted: host.retry.exhausted,
      exitCode: host.agent.exitCode,
      signal: host.agent.signal,
      timedOut: host.agent.timedOut,
      aborted: host.agent.aborted,
      error: host.agent.error,
      stdoutTruncated: host.agent.stdoutTruncated,
      stderrTruncated: host.agent.stderrTruncated,
    },
  };
}

export async function runCrossSessionEvaluation(
  options: RunCrossSessionEvaluationOptions,
): Promise<CrossSessionEvalReport> {
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) {
    throw new RepoMindError("INVALID_INPUT", "--repeat must be an integer between 1 and 100");
  }
  const defaultRunner = options.runner ?? "opencode";
  const stageAgents = resolveStageAgents(options.manifest, defaultRunner, options.model);
  const outputDirectory = resolve(options.outputDirectory);
  prepareOutputDirectory(outputDirectory);
  const execute = options.execute ?? defaultExecutor;
  const adapterFactory: CrossSessionAdapterFactory = options.adapterFactory
    ?? ((runner, factoryOptions) => createAgentHostAdapter(runner, factoryOptions));
  const adapters = new Map<CrossSessionRunner, AgentHostAdapter>();
  const adapterFor = (runner: CrossSessionRunner): AgentHostAdapter => {
    const existing = adapters.get(runner);
    if (existing) return existing;
    const factoryOptions: AgentHostAdapterFactoryOptions = {
      ...(runner === defaultRunner && options.runnerExecutable !== undefined
        ? { executable: options.runnerExecutable }
        : {}),
      ...(runner === "opencode" && options.executeOpenCode !== undefined
        ? { execute: options.executeOpenCode }
        : {}),
    };
    const adapter = adapterFactory(runner, factoryOptions);
    if (adapter.id !== runner) {
      throw new RepoMindError(
        "INVALID_INPUT",
        `Agent adapter factory returned ${adapter.id} for requested runner ${runner}`,
      );
    }
    adapters.set(runner, adapter);
    return adapter;
  };
  const configuredRunners = new Set([...stageAgents.values()].map((stage) => stage.runner));
  const runnerVersions: Partial<Record<CrossSessionRunner, string | null>> = {};
  for (const runner of configuredRunners) {
    const adapter = adapterFor(runner);
    if (runner === "opencode" && options.adapterFactory === undefined && options.executeOpenCode !== undefined) {
      const result = execute({
        command: adapter.executable, args: ["--version"], cwd: outputDirectory, timeoutMs: 30_000,
      });
      runnerVersions[runner] = result.status === 0 ? result.stdout.trim() || null : null;
    } else {
      try {
        runnerVersions[runner] = await adapter.version(outputDirectory);
      } catch {
        runnerVersions[runner] = null;
      }
    }
  }
  const repoMindRoot = resolve(options.repoMindRoot);
  const commitResult = execute({
    command: "git", args: ["rev-parse", "HEAD"], cwd: repoMindRoot, timeoutMs: 30_000,
  });
  const repoMindCommit = commitResult.status === 0 ? commitResult.stdout.trim() || null : null;
  const statusResult = execute({
    command: "git", args: ["status", "--porcelain"], cwd: repoMindRoot, timeoutMs: 30_000,
  });
  const repoMindDirty = statusResult.status === 0 ? statusResult.stdout.trim().length > 0 : null;
  const runs: CrossSessionStageRun[] = [];
  for (const [sequenceIndex, sequence] of options.manifest.sequences.entries()) for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
    const projectId = randomUUID();
    const armOrder: CrossSessionArm[] = (iteration + sequenceIndex) % 2 === 1
      ? ["isolated", "shared"]
      : ["shared", "isolated"];
    for (const arm of armOrder) {
      let sourceRepository = sequence.baseRepository;
      let sourceCommit = sequence.baseCommit;
      let previousCheckpointCommit: string | null = null;
      const sharedDataDirectory = join(outputDirectory, "data", `${sequence.id}-${iteration}-shared`);
      for (const [stageIndex, stage] of sequence.stages.entries()) {
        const stageAgent = stageAgents.get(stageAgentKey(sequence.id, stage.id));
        if (!stageAgent) throw new RepoMindError("INVALID_INPUT", `Missing resolved Agent for ${sequence.id}/${stage.id}`);
        const dataDirectory = arm === "shared"
          ? sharedDataDirectory
          : join(outputDirectory, "data", `${sequence.id}-${iteration}-isolated-s${stageIndex + 1}`);
        const run = await executeStage({
          sequence,
          stage,
          stageIndex,
          arm,
          iteration,
          projectId,
          sourceRepository,
          sourceCommit,
          previousCheckpointCommit,
          dataDirectory,
          options,
          outputDirectory,
          runner: stageAgent.runner,
          model: stageAgent.model,
          adapter: adapterFor(stageAgent.runner),
          execute,
        });
        runs.push(run);
        sourceRepository = run.repository;
        sourceCommit = run.checkpointCommit;
        previousCheckpointCommit = run.checkpointCommit;
      }
    }
  }
  const report = buildCrossSessionReport({
    name: options.manifest.name,
    repeat: options.repeat,
    outputDirectory,
    runs,
    expected: options.manifest.sequences.map((sequence) => ({
      sequenceId: sequence.id,
      stages: sequence.stages.map((stage) => {
        const stageAgent = stageAgents.get(stageAgentKey(sequence.id, stage.id));
        if (!stageAgent) throw new RepoMindError("INVALID_INPUT", `Missing resolved Agent for ${sequence.id}/${stage.id}`);
        return {
          stageId: stage.id,
          ...stageAgent,
          maxMemories: stage.maxMemories ?? options.maxMemories ?? 5,
        };
      }),
    })),
    provenance: {
      repoMindVersion: VERSION,
      repoMindCommit,
      repoMindDirty,
      node: process.version,
      os: { platform: process.platform, release: osRelease(), arch: process.arch },
      runnerVersions,
      manifestSha256: options.manifestSha256
        ?? createHash("sha256").update(JSON.stringify(options.manifest)).digest("hex"),
      sequenceBaseCommits: Object.fromEntries(options.manifest.sequences.map((sequence) => [
        sequence.id,
        runs.find((run) => run.sequenceId === sequence.id && run.stageIndex === 0)?.baseCommit
          ?? sequence.baseCommit,
      ])),
    },
    ...(options.manifest.acceptance ? { acceptanceCriteria: options.manifest.acceptance } : {}),
  });
  writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDirectory, "summary.md"), renderCrossSessionMarkdown(report), "utf8");
  return report;
}
