import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { dataRoot } from "../../config/paths.js";
import type { CommitSessionResult, StartSessionResult } from "../../domain/types.js";
import { RepoMindError } from "../../errors.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { redactDeep, redactSecrets } from "../../security/redaction.js";
import { analyzeAgentEvents, type AgentEventMetrics } from "../../eval/agent/events.js";
import {
  abandonHostLifecycle,
  analyzeOpenCodeOutcome,
  beginHostRunLifecycle,
  commitHostLifecycle,
  finishHostRunLifecycle,
  hostManagedPrompt,
  startHostLifecycle,
} from "./lifecycle.js";

const HOST_AGENT = "repomind-host";
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

export interface OpenCodeProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface OpenCodeProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export type OpenCodeProcessExecutor = (request: OpenCodeProcessRequest) => Promise<OpenCodeProcessResult>;

export interface RunOpenCodeHostOptions {
  repository: string;
  task: string;
  runnerExecutable?: string;
  model?: string;
  maxMemories?: number;
  timeoutMs?: number;
  outputDirectory?: string;
  dataDirectory?: string;
  signal?: AbortSignal;
  execute?: OpenCodeProcessExecutor;
  onStatus?: (message: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface HostRunReport {
  version: 1;
  runId: string;
  startedAt: string;
  endedAt: string;
  repository: string;
  task: string;
  runner: "opencode";
  model: string | null;
  outputDirectory: string;
  artifacts: { events: string; stderr: string; report: string };
  session: {
    id: string;
    status: "committed" | "partial" | "failed" | "abandoned";
    retrievedMemories: number;
    retrievalStrategy: StartSessionResult["retrievalStrategy"] | null;
    retrievalFallbackReason: string | null;
    startMs: number;
    commitMs: number | null;
    abandonMs: number | null;
  };
  agent: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    timedOut: boolean;
    aborted: boolean;
    error: string | null;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    events: AgentEventMetrics;
  };
  commit: CommitSessionResult | null;
  summary: string;
  succeeded: boolean;
  redactions: { events: number; stderr: number; report: number };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function appendLimited(current: string, chunk: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURE_BYTES) return { value: current, truncated: true };
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= MAX_CAPTURE_BYTES) return { value: combined, truncated: false };
  return { value: Buffer.from(combined, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8"), truncated: true };
}

export const executeOpenCodeProcess: OpenCodeProcessExecutor = (request) => new Promise((resolvePromise) => {
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;
  let settled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = (reason: "timeout" | "abort"): void => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    forceKill.unref();
  };
  const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
  timeout.unref();
  const abort = (): void => stop("abort");
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const appended = appendLimited(stdout, chunk);
    stdout = appended.value;
    stdoutTruncated ||= appended.truncated;
    request.onStdout?.(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    const appended = appendLimited(stderr, chunk);
    stderr = appended.value;
    stderrTruncated ||= appended.truncated;
    request.onStderr?.(chunk);
  });
  child.on("error", (error) => { spawnError = error.message; });
  child.on("close", (exitCode, signal) => {
    settled = true;
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    request.signal?.removeEventListener("abort", abort);
    resolvePromise({
      exitCode,
      signal,
      stdout,
      stderr,
      durationMs: round(performance.now() - started),
      timedOut,
      aborted,
      stdoutTruncated,
      stderrTruncated,
      ...(spawnError ? { error: spawnError } : {}),
    });
  });
});

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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hostManagedOpenCodeConfig(existing: string | undefined): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      base = objectValue(JSON.parse(existing) as unknown);
    } catch (error) {
      throw new RepoMindError("INVALID_INPUT", "OPENCODE_CONFIG_CONTENT is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const agents = objectValue(base.agent);
  const mcp = objectValue(base.mcp);
  const repoMindMcp = objectValue(mcp.repomind);
  return JSON.stringify({
    ...base,
    agent: {
      ...agents,
      [HOST_AGENT]: {
        description: "OpenCode Agent with a RepoMind host-managed lifecycle",
        mode: "primary",
        prompt: "Complete the repository task directly, verify the result, and provide a concise final summary. RepoMind lifecycle is managed by the host; do not call RepoMind session or memory tools.",
        tools: { task: false, call_omo_agent: false, teammate: false, background_output: false, background_cancel: false },
        permission: { task: "deny", call_omo_agent: "deny", teammate: "deny", "task_*": "deny" },
      },
    },
    mcp: { ...mcp, repomind: { ...repoMindMcp, enabled: false } },
  });
}

function defaultOutputDirectory(sessionId: string, root = dataRoot()): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return join(root, "runs", `${timestamp}-${sessionId}`);
}

function prepareOutputDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length) {
    throw new RepoMindError("INVALID_INPUT", `Run output directory is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

export async function runOpenCodeHost(options: RunOpenCodeHostOptions): Promise<HostRunReport> {
  const repository = resolve(locateGitRoot(options.repository));
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxMemories = options.maxMemories ?? 5;
  if (!options.task.trim()) throw new RepoMindError("INVALID_INPUT", "--task is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RepoMindError("INVALID_INPUT", `Invalid timeout ${timeoutMs}`);
  if (!Number.isInteger(maxMemories) || maxMemories < 0 || maxMemories > 20) {
    throw new RepoMindError("INVALID_INPUT", `maxMemories must be an integer between 0 and 20; received ${maxMemories}`);
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  options.onStatus?.("Starting RepoMind session and retrieving memories...");
  const started = await startHostLifecycle(repository, options.task, options.dataDirectory, maxMemories);
  let sessionClosed = false;
  let runRegistered = false;
  let abandonMs: number | null = null;
  const outputDirectory = resolve(options.outputDirectory ?? defaultOutputDirectory(started.sessionId, options.dataDirectory));
  try {
    beginHostRunLifecycle(repository, options.dataDirectory, {
      sessionId: started.sessionId,
      task: options.task,
      runner: "opencode",
      ...(options.model ? { model: options.model } : {}),
      outputDirectory,
      retrievedMemories: started.result.memories.length,
      startedAt: startedAtMs,
    });
    runRegistered = true;
    prepareOutputDirectory(outputDirectory);
    const eventsPath = join(outputDirectory, "events.jsonl");
    const stderrPath = join(outputDirectory, "stderr.log");
    const reportPath = join(outputDirectory, "run.json");
    const args = ["run", "--pure", "--format", "json", "--auto", "--agent", HOST_AGENT, "--dir", repository];
    if (options.model) args.push("--model", options.model);
    args.push(hostManagedPrompt(options.task, started.result.memories));
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: hostManagedOpenCodeConfig(process.env.OPENCODE_CONFIG_CONTENT),
    };

    options.onStatus?.(`Running OpenCode with ${started.result.memories.length} retrieved memories...`);
    const agent = await (options.execute ?? executeOpenCodeProcess)({
      command: resolveOpenCode(options.runnerExecutable),
      args,
      cwd: repository,
      env,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    });
    const interrupted = agent.timedOut || agent.aborted || agent.signal !== null || agent.error !== undefined || agent.exitCode === null;
    const outcome = analyzeOpenCodeOutcome(
      agent.stdout,
      `OpenCode ended with exit code ${agent.exitCode ?? "unknown"}${agent.signal ? ` and signal ${agent.signal}` : ""}.`,
    );
    const eventMetrics = analyzeAgentEvents(agent.stdout);
    let committed: CommitSessionResult | null = null;
    let commitMs: number | null = null;
    let sessionStatus: HostRunReport["session"]["status"];
    if (interrupted) {
      options.onStatus?.("OpenCode did not complete normally; abandoning RepoMind session...");
      abandonMs = abandonHostLifecycle(repository, started.sessionId, options.dataDirectory).abandonMs;
      sessionClosed = true;
      sessionStatus = "abandoned";
    } else {
      options.onStatus?.("Committing Agent evidence to RepoMind...");
      const tests = outcome.commands.filter((command) => command.isTest).map(({ isTest: _isTest, ...command }) => command);
      const commands = outcome.commands.filter((command) => !command.isTest).map(({ isTest: _isTest, ...command }) => command);
      const status = agent.exitCode === 0
        ? tests.every((test) => test.exitCode === 0) && !agent.stdoutTruncated && eventMetrics.repoMindCalls === 0 ? "success" : "partial"
        : "failed";
      const commit = commitHostLifecycle({
        repository,
        ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
        sessionId: started.sessionId,
        idempotencyKey: `opencode-host-${started.sessionId}`,
        status,
        summary: outcome.summary,
        tests,
        commands,
      });
      committed = commit.result;
      commitMs = commit.commitMs;
      sessionClosed = true;
      sessionStatus = commit.result.status as HostRunReport["session"]["status"];
    }

    const redactedEvents = redactSecrets(agent.stdout);
    const redactedStderr = redactSecrets(agent.stderr);
    writeFileSync(eventsPath, redactedEvents.content, "utf8");
    writeFileSync(stderrPath, redactedStderr.content, "utf8");
    const rawReport = {
      version: 1 as const,
      runId: started.sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      repository,
      task: options.task,
      runner: "opencode" as const,
      model: options.model ?? null,
      outputDirectory,
      artifacts: { events: eventsPath, stderr: stderrPath, report: reportPath },
      session: {
        id: started.sessionId,
        status: sessionStatus,
        retrievedMemories: started.result.memories.length,
        retrievalStrategy: started.result.retrievalStrategy ?? null,
        retrievalFallbackReason: started.result.retrievalFallbackReason ?? null,
        startMs: started.startMs,
        commitMs,
        abandonMs,
      },
      agent: {
        exitCode: agent.exitCode,
        signal: agent.signal,
        durationMs: agent.durationMs,
        timedOut: agent.timedOut,
        aborted: agent.aborted,
        error: agent.error ?? null,
        stdoutTruncated: agent.stdoutTruncated,
        stderrTruncated: agent.stderrTruncated,
        events: eventMetrics,
      },
      commit: committed,
      summary: outcome.summary,
      succeeded: agent.exitCode === 0 && committed?.status === "committed",
    };
    const redactedReport = redactDeep(rawReport);
    const report: HostRunReport = {
      ...redactedReport.value,
      redactions: {
        events: redactedEvents.redactions,
        stderr: redactedStderr.redactions,
        report: redactedReport.redactions,
      },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    finishHostRunLifecycle(repository, options.dataDirectory, {
      runId: started.sessionId,
      status: sessionStatus,
      reportPath,
      agentExitCode: agent.exitCode,
      agentSignal: agent.signal,
      durationMs: Date.now() - startedAtMs,
      inputTokens: eventMetrics.tokens.input,
      outputTokens: eventMetrics.tokens.output,
      repoMindCalls: eventMetrics.repoMindCalls,
      ...(agent.error ? { error: agent.error } : {}),
      metadata: {
        artifacts: report.artifacts,
        succeeded: report.succeeded,
        startMs: report.session.startMs,
        commitMs: report.session.commitMs,
        abandonMs: report.session.abandonMs,
        redactions: report.redactions,
      },
    });
    options.onStatus?.(`RepoMind session ${sessionStatus}; artifacts: ${outputDirectory}`);
    return report;
  } catch (error) {
    let abandoned = false;
    if (!sessionClosed) {
      try {
        abandonHostLifecycle(repository, started.sessionId, options.dataDirectory);
        sessionClosed = true;
        abandoned = true;
      } catch { /* preserve the original error */ }
    }
    if (runRegistered) {
      try {
        finishHostRunLifecycle(repository, options.dataDirectory, {
          runId: started.sessionId,
          status: abandoned ? "abandoned" : "failed",
          durationMs: Date.now() - startedAtMs,
          error: error instanceof Error ? error.message : String(error),
          metadata: { outputDirectory, sessionClosed },
        });
      } catch { /* preserve the original error */ }
    }
    throw error;
  }
}
