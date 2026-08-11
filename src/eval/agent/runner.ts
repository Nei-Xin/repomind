import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import type { TestEvidenceInput } from "../../domain/types.js";
import { RepoMindError } from "../../errors.js";
import { inspectGit } from "../../git/git-inspector.js";
import { initializeRepository } from "../../repository.js";
import { VERSION } from "../../version.js";
import {
  analyzeOpenCodeOutcome,
  assessOpenCodeOutcome,
  commitHostLifecycle,
  startHostLifecycle,
  type HostOutcomeAssessment,
} from "../../integrations/opencode/lifecycle.js";
import { renderHostContext } from "../../integrations/opencode/context.js";
import { summarizeDerivedMaintenance } from "../../integrations/opencode/run.js";
import { analyzeAgentEvents } from "./events.js";
import type { AgentCheck, AgentManifest, AgentTask } from "./manifest.js";
import {
  buildAgentReport,
  renderAgentMarkdown,
  type AgentArm,
  type AgentContextTelemetry,
  type AgentEvalReport,
  type AgentMaintenanceTelemetry,
  type AgentRunResult,
  type CheckResult,
  type RepoMindLifecycleMode,
} from "./report.js";

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type ProcessExecutor = (request: ProcessRequest) => SpawnSyncReturns<string>;

const defaultExecutor: ProcessExecutor = ({ command, args, cwd, env, timeoutMs }) => spawnSync(command, args, {
  cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: timeoutMs,
  maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: false,
});

export interface RunAgentEvaluationOptions {
  manifest: AgentManifest;
  model: string;
  repeat: number;
  outputDirectory: string;
  repoMindCli: string;
  runnerExecutable?: string;
  manifestSha256?: string;
  timeoutMs?: number;
  lifecycleMode?: RepoMindLifecycleMode;
  execute?: ProcessExecutor;
}

function requireSuccess(result: SpawnSyncReturns<string>, description: string): string {
  if (result.error || result.status !== 0) {
    throw new RepoMindError("INVALID_INPUT", `${description} failed`, {
      cause: result.error?.message ?? result.stderr ?? result.stdout,
      exitCode: result.status,
    });
  }
  return result.stdout.trim();
}

function resolveOpenCode(executable = "opencode"): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return resolve(executable);
  if (executable !== "opencode") return executable;
  if (process.platform !== "win32") return executable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const native = join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(native)) return native;
  }
  return `${executable}.exe`;
}

function controlledConfig(model: string, repoMindCli: string | null, dataDirectory: string, lifecycleMode: RepoMindLifecycleMode): object {
  const lifecycleInstruction = lifecycleMode === "host-managed"
    ? "RepoMind lifecycle is managed by the host. Do not call RepoMind session or memory tools."
    : "If RepoMind tools are available, start and commit the repository session and always close it before the final response.";
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "benchmark",
    agent: {
      benchmark: {
        description: "Controlled primary agent for RepoMind evaluation",
        mode: "primary", model, variant: "medium",
        prompt: `Complete the requested repository task directly. Do not delegate or start background agents. Inspect only relevant files, make the smallest justified change, run required verification, and provide a final result. ${lifecycleInstruction}`,
        tools: { task: false, call_omo_agent: false, teammate: false, background_output: false, background_cancel: false },
        permission: { task: "deny", call_omo_agent: "deny", teammate: "deny", "task_*": "deny", question: "deny" },
      },
    },
    mcp: repoMindCli ? {
      repomind: {
        type: "local", command: [process.execPath, repoMindCli, "mcp"], enabled: true,
        environment: { REPOMIND_DATA_DIR: dataDirectory },
      },
    } : {},
  };
}

function replaceRepo(value: string, repository: string): string {
  return value.replaceAll("{repo}", repository);
}

function taskPrompt(task: AgentTask, arm: AgentArm): string {
  if (arm !== "full-history") return task.prompt;
  const history = task.fullHistory!.map((entry, index) => `[${index + 1}] ${entry}`).join("\n\n");
  return `The following raw project history may include obsolete attempts, corrections, and irrelevant details. Evaluate it against the current repository before using it.\n\n${history}\n\nCurrent task:\n${task.prompt}`;
}

function runChecks(checks: AgentCheck[], repository: string, execute: ProcessExecutor): CheckResult[] {
  return checks.map((check) => {
    const started = performance.now();
    const command = replaceRepo(check.command, repository);
    const args = check.args.map((arg) => replaceRepo(arg, repository));
    const result = execute({ command, args, cwd: repository, timeoutMs: check.timeoutMs ?? 60_000 });
    return {
      command, args, exitCode: result.status, signal: result.signal,
      stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "",
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      passed: result.status === 0 && !result.error,
    };
  });
}

function checkEvidence(check: CheckResult): TestEvidenceInput {
  const command = [check.command, ...check.args].map((value) => JSON.stringify(value)).join(" ");
  const output = [check.stdout.trim(), check.stderr.trim()].filter(Boolean).join("\n");
  const fallback = check.exitCode === null
    ? "Host check could not be executed."
    : check.passed ? "Host check passed." : "Host check failed.";
  return {
    command,
    exitCode: check.exitCode ?? 1,
    summary: (output || fallback).slice(0, 2_000),
  };
}

export function parseChangedFiles(porcelain: string): string[] {
  return porcelain.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim());
}

function seedRepoMind(repository: string, dataDirectory: string, task: AgentTask): void {
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    initializeRepository(repository).database.close();
    const core = new RepositoryMemoryCore(repository);
    try {
      for (const memory of task.memories) core.record({
        type: memory.type,
        title: memory.title,
        content: memory.content,
        ...(memory.confidence !== undefined ? { confidence: memory.confidence } : {}),
        ...(memory.tags !== undefined ? { tags: memory.tags } : {}),
        ...(memory.relatedFiles !== undefined ? { relatedFiles: memory.relatedFiles } : {}),
      });
      const maintenance = core.maintainDerivedLayers();
      if (maintenance.status === "partial" || maintenance.status === "failed") {
        throw new RepoMindError("STORAGE_UNAVAILABLE", "Unable to seed layered RepoMind evaluation context", {
          l2: maintenance.l2.error,
          l3: maintenance.l3.error,
          l4: maintenance.l4.error,
        });
      }
    } finally { core.close(); }
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

function sessionState(repository: string, dataDirectory: string, clean: boolean): { sessions: Array<{ id: string; status: string }>; abandoned: number; openAfter: number } {
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    const core = new RepositoryMemoryCore(repository);
    try {
      const sessions = core.listSessions() as Array<{ id: string; status: string }>;
      let abandoned = 0;
      if (clean) for (const session of sessions.filter((entry) => entry.status === "open")) {
        core.abandonSession(session.id); abandoned += 1;
      }
      const openAfter = (core.listSessions() as Array<{ status: string }>).filter((entry) => entry.status === "open").length;
      return { sessions, abandoned, openAfter };
    } finally { core.close(); }
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

async function executeRun(task: AgentTask, arm: AgentArm, iteration: number, options: RunAgentEvaluationOptions, execute: ProcessExecutor, runner: string): Promise<AgentRunResult> {
  const name = `${task.id}-${arm}-${iteration}`;
  const repository = join(options.outputDirectory, "runs", name);
  const dataDirectory = join(options.outputDirectory, "data", name);
  if (existsSync(repository)) throw new RepoMindError("INVALID_INPUT", `Run directory already exists: ${repository}`);
  mkdirSync(dirname(repository), { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  requireSuccess(execute({ command: "git", args: ["clone", "--quiet", "--no-checkout", task.baseRepository, repository], cwd: options.outputDirectory, timeoutMs: 120_000 }), `Clone ${task.id}`);
  requireSuccess(execute({ command: "git", args: ["checkout", "--quiet", "--detach", task.baseCommit], cwd: repository, timeoutMs: 60_000 }), `Checkout ${task.id}`);
  const requestedCommit = requireSuccess(execute({ command: "git", args: ["rev-parse", task.baseCommit], cwd: repository, timeoutMs: 30_000 }), `Resolve base commit for ${task.id}`);
  const baseCommit = requireSuccess(execute({ command: "git", args: ["rev-parse", "HEAD"], cwd: repository, timeoutMs: 30_000 }), `Inspect base commit for ${task.id}`);
  if (arm === "repomind") seedRepoMind(repository, dataDirectory, task);
  const repoMindLifecycle = options.lifecycleMode ?? "agent-managed";
  let startMs: number | null = arm === "repomind" && repoMindLifecycle === "agent-managed" ? null : 0;
  let commitMs: number | null = arm === "repomind" && repoMindLifecycle === "agent-managed" ? null : 0;
  let maintenanceMs: number | null = arm === "repomind" && repoMindLifecycle === "agent-managed" ? null : 0;
  let hostSessionId: string | null = null;
  let hostRetrievedMemories = 0;
  let hostStartSucceeded = false;
  let hostCommitSucceeded = false;
  let hostCommitStatus: string | null = null;
  let hostMaintenanceAttempted = false;
  let hostMaintenanceStatus: string | null = null;
  let hostEvidenceCreated = 0;
  let lifecycleError: string | null = null;
  let quality: HostOutcomeAssessment | null = null;
  let contextTelemetry: AgentContextTelemetry = arm === "repomind"
    ? { availability: "unavailable", reason: "Agent-managed lifecycle does not expose Host context telemetry." }
    : { availability: "not-applicable", reason: `${arm} does not use RepoMind Host context.` };
  let maintenanceTelemetry: AgentMaintenanceTelemetry = arm === "repomind"
    ? { availability: "unavailable", reason: "Agent-managed lifecycle does not expose Host maintenance telemetry." }
    : { availability: "not-applicable", reason: `${arm} does not use RepoMind derived maintenance.` };
  let prompt = taskPrompt(task, arm);
  if (arm === "repomind" && repoMindLifecycle === "host-managed") {
    const phaseStarted = performance.now();
    try {
      const hostStart = await startHostLifecycle(repository, task.prompt, dataDirectory);
      hostSessionId = hostStart.sessionId;
      hostRetrievedMemories = hostStart.result.memories.length;
      hostStartSucceeded = true;
      const rendered = renderHostContext({
        task: task.prompt,
        memories: hostStart.result.memories,
        moduleNarratives: hostStart.result.moduleNarratives ?? [],
        repositoryProfile: hostStart.result.repositoryProfile,
      });
      prompt = rendered.prompt;
      contextTelemetry = {
        availability: "full",
        policy: { version: 1, unit: "utf16-code-units", weights: { l1: 5, l2: 3, l3: 2 } },
        retrieval: {
          maxMemories: 5,
          strategy: hostStart.result.retrievalStrategy ?? null,
          fallbackReason: hostStart.result.retrievalFallbackReason ?? null,
          l1: hostStart.result.memories.map((memory) => ({
            id: memory.id,
            version: null,
            type: memory.type,
            status: memory.status,
          })),
          l2: (hostStart.result.moduleNarratives ?? []).map((narrative) => ({
            id: narrative.id,
            version: narrative.version,
            modulePath: narrative.modulePath,
            current: narrative.current,
          })),
          l3: hostStart.result.repositoryProfile ? {
            id: hostStart.result.repositoryProfile.id,
            version: hostStart.result.repositoryProfile.version,
            current: hostStart.result.repositoryProfile.current,
          } : null,
        },
        context: rendered.stats,
      };
      maintenanceTelemetry = {
        availability: "full",
        attempted: false,
        trigger: "session-not-committed",
        report: null,
        reason: "Session has not been committed yet.",
      };
      startMs = Math.round((performance.now() - phaseStarted) * 1000) / 1000;
    } catch (error) {
      startMs = Math.round((performance.now() - phaseStarted) * 1000) / 1000;
      lifecycleError = `start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const exposeMcp = arm === "repomind" && repoMindLifecycle === "agent-managed";
  writeFileSync(join(repository, "opencode.json"), `${JSON.stringify(controlledConfig(options.model, exposeMcp ? options.repoMindCli : null, dataDirectory, repoMindLifecycle), null, 2)}\n`, "utf8");
  appendFileSync(join(repository, ".git", "info", "exclude"), "\nopencode.json\n.repomind/\n", "utf8");

  const started = performance.now();
  const agent = execute({
    command: runner,
    args: ["run", "--pure", "--format", "json", "--auto", "--agent", "benchmark", "--dir", repository, prompt],
    cwd: repository, timeoutMs: options.timeoutMs ?? 600_000,
  });
  const agentMs = Math.round((performance.now() - started) * 1000) / 1000;
  const rawLog = agent.stdout ?? "";
  const stderrLog = agent.stderr ?? agent.error?.message ?? "";
  const events = analyzeAgentEvents(rawLog);
  const resultDirectory = join(options.outputDirectory, "raw");
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(join(resultDirectory, `${name}.jsonl`), rawLog, "utf8");
  writeFileSync(join(resultDirectory, `${name}.stderr.txt`), stderrLog, "utf8");
  const verificationSnapshotBefore = arm === "repomind" && repoMindLifecycle === "host-managed" && hostSessionId
    ? inspectGit(repository)
    : null;
  const publicChecks = runChecks(task.publicChecks, repository, execute);
  const hiddenChecks = runChecks(task.hiddenChecks, repository, execute);
  const verificationSnapshotAfter = verificationSnapshotBefore ? inspectGit(repository) : null;
  const verificationSnapshotStable = verificationSnapshotBefore && verificationSnapshotAfter
    ? JSON.stringify(verificationSnapshotBefore) === JSON.stringify(verificationSnapshotAfter)
    : false;
  const statusResult = execute({ command: "git", args: ["status", "--short"], cwd: repository, timeoutMs: 30_000 });
  requireSuccess(statusResult, `Inspect changes for ${task.id}`);
  const changedFiles = parseChangedFiles(statusResult.stdout);
  const unexpectedChanges = task.allowedChanges ? changedFiles.filter((path) => !task.allowedChanges!.includes(path)) : [];
  if (arm === "repomind" && repoMindLifecycle === "host-managed" && hostSessionId) {
    const phaseStarted = performance.now();
    try {
      const outcome = analyzeOpenCodeOutcome(rawLog, `OpenCode completed task ${task.id} with exit code ${agent.status ?? "unknown"}.`);
      quality = assessOpenCodeOutcome({
        agentExitCode: agent.status,
        commands: outcome.commands,
        authoritativeChecks: [...publicChecks, ...hiddenChecks],
        authoritativeVerificationAuthority: "benchmark-manifest",
        verificationSnapshotStable,
        trace: outcome.trace,
        repoMindCalls: events.repoMindCalls,
      });
      // Hidden checks authorize the outcome but must never become later memory.
      const authoritativeEvidence = publicChecks.map(checkEvidence);
      const observedCommands = outcome.commands.map(({ isTest: _isTest, exitCodeKnown: _exitCodeKnown, ...command }) => command);
      const committed = commitHostLifecycle({
        repository, dataDirectory, sessionId: hostSessionId,
        idempotencyKey: `${task.id}-${iteration}-host-lifecycle`,
        status: quality.status,
        summary: outcome.summary,
        tests: authoritativeEvidence,
        commands: observedCommands,
      });
      maintenanceMs = committed.maintenanceMs ?? 0;
      commitMs = committed.commitMs;
      hostCommitSucceeded = true;
      hostCommitStatus = committed.result.status;
      hostMaintenanceAttempted = committed.maintenance !== null;
      hostMaintenanceStatus = committed.maintenance?.status ?? null;
      hostEvidenceCreated = committed.result.evidenceCreated;
      const maintenanceReport = summarizeDerivedMaintenance(
        committed.maintenance,
        committed.maintenanceBefore,
        committed.maintenanceAfter,
        committed.maintenanceTelemetryErrors,
      );
      maintenanceTelemetry = {
        availability: "full",
        attempted: committed.maintenance !== null,
        trigger: committed.result.status === "committed" ? "committed-session" : "session-not-committed",
        report: maintenanceReport,
        reason: committed.maintenance === null ? `Session status ${committed.result.status} is not eligible for maintenance.` : null,
      };
    } catch (error) {
      commitMs = Math.round((performance.now() - phaseStarted) * 1000) / 1000;
      maintenanceMs = 0;
      lifecycleError = [lifecycleError, `commit: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; ");
    }
  }
  const sessions = arm === "repomind" ? sessionState(repository, dataDirectory, true) : { sessions: [], abandoned: 0, openAfter: 0 };
  const lifecycleMode = arm === "repomind" ? repoMindLifecycle : "none";
  const agentManagedStart = events.toolCalls.repomind_repo_session_start ?? 0;
  const agentManagedCommit = events.toolCalls.repomind_repo_session_commit ?? 0;
  const committedSession = sessions.sessions.find((session) => session.status !== "open") ?? null;
  const totalLifecycleMs = lifecycleMode === "host-managed"
    ? Math.round(((startMs ?? 0) + agentMs + (commitMs ?? 0) + (maintenanceMs ?? 0)) * 1000) / 1000
    : agentMs;
  return {
    taskId: task.id, arm, iteration, repository, requestedCommit, baseCommit,
    agentExitCode: agent.status, agentSignal: agent.signal,
    startMs, agentMs, commitMs, maintenanceMs, totalLifecycleMs, wallDurationMs: totalLifecycleMs,
    publicChecks, hiddenChecks, changedFiles, unexpectedChanges,
    sessionsBeforeCleanup: sessions.sessions, abandonedSessions: sessions.abandoned,
    openSessionsAfterCleanup: sessions.openAfter,
    lifecycle: {
      mode: lifecycleMode,
      timing: lifecycleMode === "host-managed" ? "sequential" : lifecycleMode === "agent-managed" ? "nested-in-agent" : "not-applicable",
      startAttempted: lifecycleMode === "host-managed" || agentManagedStart > 0,
      startSucceeded: lifecycleMode === "host-managed" ? hostStartSucceeded : agentManagedStart > 0,
      sessionId: hostSessionId ?? sessions.sessions[0]?.id ?? null,
      retrievedMemories: lifecycleMode === "host-managed" ? hostRetrievedMemories : events.retrievedMemories,
      commitAttempted: lifecycleMode === "host-managed" ? hostSessionId !== null : agentManagedCommit > 0,
      commitSucceeded: lifecycleMode === "host-managed" ? hostCommitSucceeded : committedSession !== null,
      commitStatus: lifecycleMode === "host-managed" ? hostCommitStatus : committedSession?.status ?? null,
      maintenanceAttempted: lifecycleMode === "host-managed" && hostMaintenanceAttempted,
      maintenanceStatus: lifecycleMode === "host-managed" ? hostMaintenanceStatus : null,
      evidenceCreated: hostEvidenceCreated,
      error: lifecycleError,
    },
    contextTelemetry,
    maintenanceTelemetry,
    quality,
    events,
  };
}

export async function runAgentEvaluation(options: RunAgentEvaluationOptions): Promise<AgentEvalReport> {
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) {
    throw new RepoMindError("INVALID_INPUT", "--repeat must be an integer between 1 and 100");
  }
  const execute = options.execute ?? defaultExecutor;
  const outputDirectory = resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const normalized = { ...options, outputDirectory };
  const runner = resolveOpenCode(options.runnerExecutable);
  const runnerVersionResult = execute({ command: runner, args: ["--version"], cwd: outputDirectory, timeoutMs: 30_000 });
  const runnerVersion = runnerVersionResult.status === 0 ? runnerVersionResult.stdout.trim() || null : null;
  const repoMindRoot = resolve(dirname(options.repoMindCli), "..", "..");
  const commitResult = execute({ command: "git", args: ["rev-parse", "HEAD"], cwd: repoMindRoot, timeoutMs: 30_000 });
  const repoMindCommit = commitResult.status === 0 ? commitResult.stdout.trim() || null : null;
  const statusResult = execute({ command: "git", args: ["status", "--porcelain"], cwd: repoMindRoot, timeoutMs: 30_000 });
  const repoMindDirty = statusResult.status === 0 ? statusResult.stdout.trim().length > 0 : null;
  const runs: AgentRunResult[] = [];
  for (const task of options.manifest.tasks) for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
    const twoArmOrders: AgentArm[][] = [["no-memory", "repomind"], ["repomind", "no-memory"]];
    const threeArmOrders: AgentArm[][] = [
      ["no-memory", "full-history", "repomind"],
      ["full-history", "repomind", "no-memory"],
      ["repomind", "no-memory", "full-history"],
    ];
    const orders = options.manifest.version === 2 ? threeArmOrders : twoArmOrders;
    const order = orders[(iteration - 1) % orders.length]!;
    for (const arm of order) runs.push(await executeRun(task, arm, iteration, normalized, execute, runner));
  }
  const report = buildAgentReport({
    name: options.manifest.name, runner: "opencode", model: options.model,
    repeat: options.repeat, repoMindLifecycle: options.lifecycleMode ?? "agent-managed", outputDirectory, runs,
    provenance: {
      repoMindVersion: VERSION,
      repoMindCommit,
      repoMindDirty,
      node: process.version,
      os: { platform: process.platform, release: osRelease(), arch: process.arch },
      runnerVersion,
      manifestSha256: options.manifestSha256 ?? createHash("sha256").update(JSON.stringify(options.manifest)).digest("hex"),
      taskBaseCommits: Object.fromEntries(options.manifest.tasks.map((task) => [
        task.id, runs.find((run) => run.taskId === task.id)?.baseCommit ?? task.baseCommit,
      ])),
    },
    ...(options.manifest.acceptance ? { acceptanceCriteria: options.manifest.acceptance } : {}),
  });
  writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDirectory, "summary.md"), renderAgentMarkdown(report), "utf8");
  return report;
}
