import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform, release } from "node:os";
import { RepositoryMemoryCore } from "../../core.js";
import { RepoMindError } from "../../errors.js";
import { initializeRepository } from "../../repository.js";
import { redactSecrets } from "../../security/redaction.js";
import { VERSION } from "../../version.js";
import {
  runOpenCodeHost,
  type HostRunReport,
  type OpenCodeProcessExecutor,
} from "../../integrations/opencode/run.js";
import { hashAgentManifest, loadAgentManifest, type AgentCheck, type AgentTask } from "./manifest.js";

export interface HostAcceptanceProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface HostAcceptanceProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export type HostAcceptanceProcessExecutor = (request: HostAcceptanceProcessRequest) => HostAcceptanceProcessResult;

export interface HostAcceptanceCheckResult extends HostAcceptanceProcessResult {
  command: string;
  args: string[];
  passed: boolean;
  redactions: number;
}

export interface HostAcceptanceTaskResult {
  taskId: string;
  repository: string;
  requestedCommit: string;
  baseCommit: string | null;
  run: HostRunReport | null;
  publicChecks: HostAcceptanceCheckResult[];
  hiddenChecks: HostAcceptanceCheckResult[];
  changedFiles: string[];
  unexpectedChanges: string[];
  openSessions: number | null;
  artifactsVerified: boolean;
  integrity: { passed: boolean; failures: string[] };
  accepted: boolean;
}

export interface HostAcceptanceReport {
  version: 1;
  generatedAt: string;
  name: string;
  model: string | null;
  manifest: { path: string; sha256: string; version: number };
  outputDirectory: string;
  provenance: {
    repoMindVersion: string;
    node: string;
    os: string;
    taskBaseCommits: Record<string, string>;
  };
  totals: {
    tasks: number;
    accepted: number;
    retrieved: number;
    committed: number;
    publicPassed: number;
    hiddenPassed: number;
  };
  tasks: HostAcceptanceTaskResult[];
  integrity: { passed: boolean; failures: string[] };
  acceptance: { passed: boolean; failures: string[] };
}

export interface RunHostAcceptanceOptions {
  manifestPath: string;
  outputDirectory: string;
  runnerExecutable?: string;
  model?: string;
  timeoutMs?: number;
  maxMemories?: number;
  executeAgent?: OpenCodeProcessExecutor;
  executeProcess?: HostAcceptanceProcessExecutor;
  onStatus?: (message: string) => void;
}

const defaultProcessExecutor: HostAcceptanceProcessExecutor = (request) => {
  const result = spawnSync(request.command === "node" ? process.execPath : request.command, request.args, {
    cwd: request.cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: request.timeoutMs,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
};

function requireSuccess(result: HostAcceptanceProcessResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new RepoMindError("INVALID_INPUT", `${action} failed`, {
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error,
      stderr: redactSecrets(result.stderr).content.slice(0, 2_000),
    });
  }
}

function prepareOutputDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length) {
    throw new RepoMindError("INVALID_INPUT", `Acceptance output directory is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
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

function runCheck(
  check: AgentCheck,
  repository: string,
  execute: HostAcceptanceProcessExecutor,
): HostAcceptanceCheckResult {
  const args = check.args.map((argument) => argument.replaceAll("{repo}", repository));
  const raw = execute({ command: check.command, args, cwd: repository, timeoutMs: check.timeoutMs ?? 120_000 });
  const stdout = redactSecrets(raw.stdout);
  const stderr = redactSecrets(raw.stderr);
  return {
    ...raw,
    stdout: stdout.content,
    stderr: stderr.content,
    command: check.command,
    args,
    passed: raw.exitCode === 0,
    redactions: stdout.redactions + stderr.redactions,
  };
}

function parseChangedFiles(status: string): string[] {
  return [...new Set(status.split(/\r?\n/u).filter(Boolean).map((line) => {
    const raw = line.slice(3).trim();
    const path = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
    return path.replace(/^"|"$/gu, "").replaceAll("\\", "/");
  }))].sort();
}

function artifactFailures(report: HostRunReport): string[] {
  const failures: string[] = [];
  for (const [name, path] of Object.entries(report.artifacts)) {
    if (!existsSync(path)) {
      failures.push(`missing ${name} artifact: ${path}`);
      continue;
    }
    const content = readFileSync(path, "utf8");
    if (redactSecrets(content).redactions > 0) failures.push(`${name} artifact contains an unredacted secret pattern`);
  }
  try {
    const stored = JSON.parse(readFileSync(report.artifacts.report, "utf8")) as HostRunReport;
    if (stored.session.id !== report.session.id) failures.push("stored run report session id does not match the returned report");
  } catch (error) {
    failures.push(`run report artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}

function cloneTask(
  task: AgentTask,
  repository: string,
  execute: HostAcceptanceProcessExecutor,
): { requestedCommit: string; baseCommit: string } {
  const requested = execute({ command: "git", args: ["rev-parse", task.baseCommit], cwd: task.baseRepository, timeoutMs: 30_000 });
  requireSuccess(requested, `Resolve base commit for ${task.id}`);
  const requestedCommit = requested.stdout.trim();
  const cloned = execute({
    command: "git",
    args: ["clone", "--quiet", "--no-hardlinks", task.baseRepository, repository],
    cwd: dirname(repository),
    timeoutMs: 120_000,
  });
  requireSuccess(cloned, `Clone task ${task.id}`);
  requireSuccess(execute({ command: "git", args: ["checkout", "--quiet", "--detach", requestedCommit], cwd: repository, timeoutMs: 30_000 }), `Checkout task ${task.id}`);
  const actual = execute({ command: "git", args: ["rev-parse", "HEAD"], cwd: repository, timeoutMs: 30_000 });
  requireSuccess(actual, `Inspect task ${task.id} base commit`);
  return { requestedCommit, baseCommit: actual.stdout.trim() };
}

function seedTask(task: AgentTask, repository: string, dataDirectory: string): void {
  withDataDirectory(dataDirectory, () => {
    initializeRepository(repository).database.close();
    appendFileSync(join(repository, ".git", "info", "exclude"), "\n.repomind/\n", "utf8");
    const core = new RepositoryMemoryCore(repository);
    try {
      for (const memory of task.memories) core.record({
        type: memory.type,
        title: memory.title,
        content: memory.content,
        ...(memory.confidence !== undefined ? { confidence: memory.confidence } : {}),
        ...(memory.tags ? { tags: memory.tags } : {}),
        ...(memory.relatedFiles ? { relatedFiles: memory.relatedFiles } : {}),
      });
    } finally {
      core.close();
    }
  });
}

function inspectOpenSessions(repository: string, dataDirectory: string): number {
  return withDataDirectory(dataDirectory, () => {
    const core = new RepositoryMemoryCore(repository);
    try {
      return (core.listSessions() as Array<{ status?: unknown }>).filter((session) => session.status === "open").length;
    } finally {
      core.close();
    }
  });
}

async function runTask(
  task: AgentTask,
  options: RunHostAcceptanceOptions,
  output: string,
  execute: HostAcceptanceProcessExecutor,
): Promise<HostAcceptanceTaskResult> {
  const repository = join(output, "runs", task.id);
  const dataDirectory = join(output, "data", task.id);
  const artifactDirectory = join(output, "artifacts", task.id);
  const failures: string[] = [];
  let requestedCommit = task.baseCommit;
  let baseCommit: string | null = null;
  let report: HostRunReport | null = null;
  let publicChecks: HostAcceptanceCheckResult[] = [];
  let hiddenChecks: HostAcceptanceCheckResult[] = [];
  let changedFiles: string[] = [];
  let unexpectedChanges: string[] = [];
  let openSessions: number | null = null;
  let artifactsVerified = false;

  try {
    const cloned = cloneTask(task, repository, execute);
    requestedCommit = cloned.requestedCommit;
    baseCommit = cloned.baseCommit;
    if (baseCommit !== requestedCommit) failures.push(`base commit mismatch: expected ${requestedCommit}, got ${baseCommit}`);
    seedTask(task, repository, dataDirectory);
    report = await runOpenCodeHost({
      repository,
      task: task.prompt,
      dataDirectory,
      outputDirectory: artifactDirectory,
      ...(options.runnerExecutable ? { runnerExecutable: options.runnerExecutable } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxMemories !== undefined ? { maxMemories: options.maxMemories } : {}),
      ...(options.executeAgent ? { execute: options.executeAgent } : {}),
    });
  } catch (error) {
    failures.push(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existsSync(repository)) {
    publicChecks = task.publicChecks.map((check) => runCheck(check, repository, execute));
    hiddenChecks = task.hiddenChecks.map((check) => runCheck(check, repository, execute));
    const status = execute({ command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"], cwd: repository, timeoutMs: 30_000 });
    if (status.exitCode === 0) {
      changedFiles = parseChangedFiles(status.stdout);
      unexpectedChanges = task.allowedChanges ? changedFiles.filter((path) => !task.allowedChanges!.includes(path)) : [];
    } else {
      failures.push("unable to inspect changed files");
    }
    try {
      openSessions = inspectOpenSessions(repository, dataDirectory);
    } catch (error) {
      failures.push(`unable to inspect sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!report) failures.push("host run report is missing");
  else {
    if (report.session.retrievedMemories < 1) failures.push("no memory was retrieved");
    if (report.agent.events.repoMindCalls !== 0) failures.push(`Agent made ${report.agent.events.repoMindCalls} RepoMind calls`);
    if (report.agent.exitCode !== 0) failures.push(`Agent exited with ${report.agent.exitCode ?? report.agent.signal ?? "unknown"}`);
    if (report.session.status !== "committed") failures.push(`session ended as ${report.session.status}`);
    if (!report.succeeded) failures.push("host run did not succeed");
    const artifactIssues = artifactFailures(report);
    failures.push(...artifactIssues);
    artifactsVerified = artifactIssues.length === 0;
  }
  if (publicChecks.some((check) => !check.passed)) failures.push("one or more public checks failed");
  if (hiddenChecks.some((check) => !check.passed)) failures.push("one or more hidden checks failed");
  if (unexpectedChanges.length) failures.push(`unexpected changed files: ${unexpectedChanges.join(", ")}`);
  if (openSessions !== 0) failures.push(`open sessions after run: ${openSessions ?? "unknown"}`);

  return {
    taskId: task.id,
    repository,
    requestedCommit,
    baseCommit,
    run: report,
    publicChecks,
    hiddenChecks,
    changedFiles,
    unexpectedChanges,
    openSessions,
    artifactsVerified,
    integrity: { passed: failures.length === 0, failures },
    accepted: failures.length === 0,
  };
}

export function renderHostAcceptanceMarkdown(report: HostAcceptanceReport): string {
  const rows = report.tasks.map((task) => `| ${task.taskId} | ${task.accepted ? "pass" : "FAIL"} | ${task.run?.session.retrievedMemories ?? 0} | ${task.run?.session.status ?? "missing"} | ${task.publicChecks.length > 0 && task.publicChecks.every((check) => check.passed) ? "pass" : "fail"} | ${task.hiddenChecks.length > 0 && task.hiddenChecks.every((check) => check.passed) ? "pass" : "fail"} | ${task.openSessions ?? "unknown"} |`).join("\n");
  const failures = report.tasks.flatMap((task) => task.integrity.failures.map((failure) => `- ${task.taskId}: ${failure}`));
  return `# RepoMind run eight-task acceptance\n\nSuite: ${report.name}\n\nModel: ${report.model ?? "OpenCode default"}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nAcceptance: **${report.acceptance.passed ? "passed" : "FAILED"}**\n\nAccepted tasks: ${report.totals.accepted}/${report.totals.tasks}\n\n## Results\n\n| Task | Accepted | Retrieved | Session | Public | Hidden | Open sessions |\n| --- | --- | ---: | --- | --- | --- | ---: |\n${rows}\n\n## Provenance\n\n- RepoMind: ${report.provenance.repoMindVersion}\n- Node: ${report.provenance.node}\n- OS: ${report.provenance.os}\n- Manifest SHA-256: \`${report.manifest.sha256}\`\n\n## Failures\n\n${failures.length ? failures.join("\n") : "None."}\n`;
}

export async function runHostAcceptance(options: RunHostAcceptanceOptions): Promise<HostAcceptanceReport> {
  const output = resolve(options.outputDirectory);
  prepareOutputDirectory(output);
  mkdirSync(join(output, "runs"), { recursive: true });
  mkdirSync(join(output, "data"), { recursive: true });
  mkdirSync(join(output, "artifacts"), { recursive: true });
  const manifestPath = resolve(options.manifestPath);
  const manifest = loadAgentManifest(manifestPath);
  if (manifest.version !== 2 || manifest.tasks.length !== 8) {
    throw new RepoMindError("INVALID_INPUT", `Host acceptance requires a manifest v2 with exactly eight tasks; received v${manifest.version} with ${manifest.tasks.length} tasks`);
  }
  const execute = options.executeProcess ?? defaultProcessExecutor;
  const tasks: HostAcceptanceTaskResult[] = [];
  for (const [index, task] of manifest.tasks.entries()) {
    options.onStatus?.(`[${index + 1}/${manifest.tasks.length}] ${task.id}`);
    tasks.push(await runTask(task, options, output, execute));
  }
  const integrityFailures = tasks.flatMap((task) => task.integrity.failures.map((failure) => `${task.taskId}: ${failure}`));
  const acceptanceFailures = tasks.filter((task) => !task.accepted).map((task) => `${task.taskId}: task acceptance failed`);
  const report: HostAcceptanceReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    name: manifest.name,
    model: options.model ?? null,
    manifest: { path: manifestPath, sha256: hashAgentManifest(manifestPath), version: manifest.version },
    outputDirectory: output,
    provenance: {
      repoMindVersion: VERSION,
      node: process.version,
      os: `${platform()} ${release()} ${process.arch}`,
      taskBaseCommits: Object.fromEntries(tasks.map((task) => [task.taskId, task.baseCommit ?? task.requestedCommit])),
    },
    totals: {
      tasks: tasks.length,
      accepted: tasks.filter((task) => task.accepted).length,
      retrieved: tasks.filter((task) => (task.run?.session.retrievedMemories ?? 0) > 0).length,
      committed: tasks.filter((task) => task.run?.session.status === "committed").length,
      publicPassed: tasks.filter((task) => task.publicChecks.length > 0 && task.publicChecks.every((check) => check.passed)).length,
      hiddenPassed: tasks.filter((task) => task.hiddenChecks.length > 0 && task.hiddenChecks.every((check) => check.passed)).length,
    },
    tasks,
    integrity: { passed: integrityFailures.length === 0, failures: integrityFailures },
    acceptance: { passed: acceptanceFailures.length === 0, failures: acceptanceFailures },
  };
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(output, "summary.md"), renderHostAcceptanceMarkdown(report), "utf8");
  return report;
}
