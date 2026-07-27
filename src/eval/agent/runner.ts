import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import { RepoMindError } from "../../errors.js";
import { initializeRepository } from "../../repository.js";
import { VERSION } from "../../version.js";
import { analyzeAgentEvents } from "./events.js";
import type { AgentCheck, AgentManifest, AgentTask } from "./manifest.js";
import { buildAgentReport, renderAgentMarkdown, type AgentArm, type AgentEvalReport, type AgentRunResult, type CheckResult } from "./report.js";

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

function controlledConfig(model: string, repoMindCli: string | null, dataDirectory: string): object {
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "benchmark",
    agent: {
      benchmark: {
        description: "Controlled primary agent for RepoMind A/B evaluation",
        mode: "primary", model, variant: "medium",
        prompt: "Complete the requested repository task directly. Do not delegate or start background agents. Inspect only relevant files, make the smallest justified change, run required verification, and provide a final result. If RepoMind tools are available, start and commit the repository session and always close it before the final response.",
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

function executeRun(task: AgentTask, arm: AgentArm, iteration: number, options: RunAgentEvaluationOptions, execute: ProcessExecutor, runner: string): AgentRunResult {
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
  writeFileSync(join(repository, "opencode.json"), `${JSON.stringify(controlledConfig(options.model, arm === "repomind" ? options.repoMindCli : null, dataDirectory), null, 2)}\n`, "utf8");
  appendFileSync(join(repository, ".git", "info", "exclude"), "\nopencode.json\n.repomind/\n", "utf8");

  const started = performance.now();
  const agent = execute({
    command: runner,
    args: ["run", "--format", "json", "--auto", "--agent", "benchmark", "--dir", repository, task.prompt],
    cwd: repository, timeoutMs: options.timeoutMs ?? 600_000,
  });
  const wallDurationMs = Math.round(performance.now() - started);
  const rawLog = agent.stdout ?? "";
  const stderrLog = agent.stderr ?? agent.error?.message ?? "";
  const resultDirectory = join(options.outputDirectory, "raw");
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(join(resultDirectory, `${name}.jsonl`), rawLog, "utf8");
  writeFileSync(join(resultDirectory, `${name}.stderr.txt`), stderrLog, "utf8");
  const publicChecks = runChecks(task.publicChecks, repository, execute);
  const hiddenChecks = runChecks(task.hiddenChecks, repository, execute);
  const statusResult = execute({ command: "git", args: ["status", "--short"], cwd: repository, timeoutMs: 30_000 });
  requireSuccess(statusResult, `Inspect changes for ${task.id}`);
  const changedFiles = parseChangedFiles(statusResult.stdout);
  const unexpectedChanges = task.allowedChanges ? changedFiles.filter((path) => !task.allowedChanges!.includes(path)) : [];
  const sessions = arm === "repomind" ? sessionState(repository, dataDirectory, true) : { sessions: [], abandoned: 0, openAfter: 0 };
  return {
    taskId: task.id, arm, iteration, repository, requestedCommit, baseCommit,
    agentExitCode: agent.status, agentSignal: agent.signal, wallDurationMs,
    publicChecks, hiddenChecks, changedFiles, unexpectedChanges,
    sessionsBeforeCleanup: sessions.sessions, abandonedSessions: sessions.abandoned,
    openSessionsAfterCleanup: sessions.openAfter, events: analyzeAgentEvents(rawLog),
  };
}

export function runAgentEvaluation(options: RunAgentEvaluationOptions): AgentEvalReport {
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
    const order: AgentArm[] = iteration % 2 === 1 ? ["no-memory", "repomind"] : ["repomind", "no-memory"];
    for (const arm of order) runs.push(executeRun(task, arm, iteration, normalized, execute, runner));
  }
  const report = buildAgentReport({
    name: options.manifest.name, runner: "opencode", model: options.model,
    repeat: options.repeat, outputDirectory, runs,
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
