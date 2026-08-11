import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataRoot } from "../../config/paths.js";
import type {
  CommitSessionResult,
  DerivedMaintenanceError,
  DerivedMaintenanceResult,
  DerivedMaintenanceStageStatus,
  GitSnapshot,
  StartSessionResult,
  TestEvidenceInput,
} from "../../domain/types.js";
import { RepoMindError } from "../../errors.js";
import { inspectGit, locateGitRoot } from "../../git/git-inspector.js";
import { redactDeep, redactSecrets } from "../../security/redaction.js";
import type { AgentEventMetrics } from "../../eval/agent/events.js";
import {
  abandonHostLifecycle,
  beginHostRunLifecycle,
  commitHostLifecycle,
  finishHostRunLifecycle,
  startHostLifecycle,
  type DerivedLayerSnapshot,
} from "../opencode/lifecycle.js";
import {
  HOST_CONTEXT_DEFAULT_BUDGET_CHARS,
  renderHostContext,
  validateHostContextBudget,
  type HostContextInjectionStats,
} from "../opencode/context.js";
import type {
  AgentHostAdapter,
  AgentHostAttemptMode,
  AgentHostRunResult,
  AgentInfrastructureRetryAssessment,
  AgentOutcome,
} from "./types.js";
import { assessAgentOutcome, type AgentOutcomeAssessment } from "./outcome.js";
import { assessAgentInfrastructureRetry } from "./retry.js";

const DEFAULT_MAX_AGENT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_AGENT_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 30_000;

export interface HostVerificationResult {
  /** Complete Host-owned check set used to assess outcome quality. */
  checks: readonly TestEvidenceInput[];
  /** Check evidence allowed to persist. Omit to persist the complete check set. */
  evidence?: readonly TestEvidenceInput[];
}

export interface RunAgentHostOptions<TId extends string = string> {
  adapter: AgentHostAdapter<TId>;
  repository: string;
  task: string;
  model?: string;
  maxMemories?: number;
  contextBudgetChars?: number;
  timeoutMs?: number;
  outputDirectory?: string;
  dataDirectory?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Maximum process attempts for strictly classified transient infrastructure failures. */
  maxAgentAttempts?: number;
  /** Fixed delay between eligible process attempts. Set to zero for tests. */
  retryDelayMs?: number;
  /** Injectable delay implementation for deterministic tests and custom schedulers. */
  retryWait?: (delayMs: number) => void | Promise<void>;
  /** Host-owned checks run after the Agent and before commit. */
  verify?: (
    repository: string,
  ) => readonly TestEvidenceInput[] | HostVerificationResult
    | Promise<readonly TestEvidenceInput[] | HostVerificationResult>;
  /** Identifies who owns the authoritative verification policy in telemetry. */
  verificationAuthority?: "host-config" | "benchmark-manifest";
}

export interface HostRunMaintenanceStage<T> {
  status: DerivedMaintenanceStageStatus;
  durationMs: number;
  result: T | null;
  error: DerivedMaintenanceError | null;
  reason: string | null;
}

export interface HostRunMaintenanceReport {
  status: DerivedMaintenanceResult["status"];
  durationMs: number;
  before: DerivedLayerSnapshot | null;
  after: DerivedLayerSnapshot | null;
  telemetryErrors: string[];
  l2: HostRunMaintenanceStage<{
    created: number;
    updated: number;
    unchanged: number;
    deleted: number;
    narratives: Array<{ id: string; modulePath: string; version: number; current: boolean }>;
  }>;
  l3: HostRunMaintenanceStage<{
    created: boolean;
    updated: boolean;
    unchanged: boolean;
    profileId: string;
    profileVersion: number;
  }>;
  l4: HostRunMaintenanceStage<{
    created: number;
    updated: number;
    unchanged: number;
    candidates: number;
    pendingCandidates: number;
  }>;
}

export interface AgentHostAttemptReport {
  attempt: number;
  executionMode: AgentHostAttemptMode;
  startedAt: string;
  endedAt: string;
  artifacts: { stdout: string; stderr: string };
  git: { before: GitSnapshot; after: GitSnapshot; unchanged: boolean };
  process: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    timedOut: boolean;
    aborted: boolean;
    error: string | null;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  outcome: AgentOutcome;
  events: AgentEventMetrics;
  retry: AgentInfrastructureRetryAssessment & {
    scheduled: boolean;
    delayMs: number | null;
  };
  redactions: { stdout: number; stderr: number };
}

export interface AgentHostRunReport<TId extends string = string> {
  version: 3;
  runId: string;
  startedAt: string;
  endedAt: string;
  repository: string;
  task: string;
  runner: TId;
  model: string | null;
  outputDirectory: string;
  artifacts: { events: string; stderr: string; report: string };
  session: {
    id: string;
    status: "committed" | "partial" | "failed" | "abandoned";
    retrievedMemories: number;
    retrievedMemoryIds: string[];
    retrievedModuleNarratives: number;
    retrievedModuleNarrativeIds: string[];
    retrievedModuleNarrativeVersions: Array<{ id: string; version: number }>;
    repositoryProfileId: string | null;
    repositoryProfileVersion: number | null;
    retrievalStrategy: StartSessionResult["retrievalStrategy"] | null;
    retrievalFallbackReason: string | null;
    startMs: number;
    commitMs: number | null;
    maintenanceMs: number | null;
    abandonMs: number | null;
  };
  context: HostContextInjectionStats;
  retry: {
    maxAttempts: number;
    delayMs: number;
    attempts: number;
    retries: number;
    exhausted: boolean;
  };
  attempts: AgentHostAttemptReport[];
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
  quality: AgentOutcomeAssessment;
  commit: CommitSessionResult | null;
  maintenance: HostRunMaintenanceReport | null;
  summary: string;
  succeeded: boolean;
  redactions: { events: number; stderr: number; report: number };
}

export function summarizeDerivedMaintenance(
  input: DerivedMaintenanceResult | null,
  before: DerivedLayerSnapshot | null = null,
  after: DerivedLayerSnapshot | null = null,
  telemetryErrors: readonly string[] = [],
): HostRunMaintenanceReport | null {
  if (!input) return null;
  const common = <T>(stage: {
    status: DerivedMaintenanceStageStatus;
    durationMs: number;
    error: DerivedMaintenanceError | null;
    reason: string | null;
  }, result: T | null): HostRunMaintenanceStage<T> => ({
    status: stage.status,
    durationMs: stage.durationMs,
    result,
    error: stage.error,
    reason: stage.reason,
  });
  return {
    status: input.status,
    durationMs: input.durationMs,
    before,
    after,
    telemetryErrors: [...telemetryErrors],
    l2: common(input.l2, input.l2.result ? {
      created: input.l2.result.created,
      updated: input.l2.result.updated,
      unchanged: input.l2.result.unchanged,
      deleted: input.l2.result.deleted,
      narratives: input.l2.result.narratives.map((narrative) => ({
        id: narrative.id,
        modulePath: narrative.modulePath,
        version: narrative.version,
        current: narrative.current,
      })),
    } : null),
    l3: common(input.l3, input.l3.result ? {
      created: input.l3.result.created,
      updated: input.l3.result.updated,
      unchanged: input.l3.result.unchanged,
      profileId: input.l3.result.profile.id,
      profileVersion: input.l3.result.profile.version,
    } : null),
    l4: common(input.l4, input.l4.result ? {
      created: input.l4.result.created,
      updated: input.l4.result.updated,
      unchanged: input.l4.result.unchanged,
      candidates: input.l4.result.candidates.length,
      pendingCandidates: input.l4.result.candidates.filter((candidate) => candidate.status === "pending").length,
    } : null),
  };
}

function verificationResult(
  value: readonly TestEvidenceInput[] | HostVerificationResult,
): { checks: readonly TestEvidenceInput[]; evidence: readonly TestEvidenceInput[] } {
  if (Array.isArray(value)) return { checks: value, evidence: value };
  const result = value as HostVerificationResult;
  return { checks: result.checks, evidence: result.evidence ?? result.checks };
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

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs === 0) return;
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, delayMs));
}

function aggregateAgentEventMetrics(values: readonly AgentEventMetrics[]): AgentEventMetrics {
  const aggregate: AgentEventMetrics = {
    turns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    toolCalls: {},
    failedTools: 0,
    failedCommands: 0,
    fileReads: 0,
    failedFileReads: 0,
    repeatedFileReads: 0,
    repoMindCalls: 0,
    retrievedMemories: 0,
  };
  for (const value of values) {
    aggregate.turns += value.turns;
    aggregate.tokens.input += value.tokens.input;
    aggregate.tokens.output += value.tokens.output;
    aggregate.tokens.reasoning += value.tokens.reasoning;
    aggregate.tokens.cacheRead += value.tokens.cacheRead;
    aggregate.tokens.cacheWrite += value.tokens.cacheWrite;
    for (const [tool, count] of Object.entries(value.toolCalls)) {
      aggregate.toolCalls[tool] = (aggregate.toolCalls[tool] ?? 0) + count;
    }
    aggregate.failedTools += value.failedTools;
    aggregate.failedCommands += value.failedCommands;
    aggregate.fileReads += value.fileReads;
    aggregate.failedFileReads += value.failedFileReads;
    aggregate.repeatedFileReads += value.repeatedFileReads;
    aggregate.repoMindCalls += value.repoMindCalls;
    aggregate.retrievedMemories += value.retrievedMemories;
  }
  aggregate.toolCalls = Object.fromEntries(
    Object.entries(aggregate.toolCalls).sort(([left], [right]) => left.localeCompare(right)),
  );
  return aggregate;
}

export async function runAgentHost<TId extends string>(
  options: RunAgentHostOptions<TId>,
): Promise<AgentHostRunReport<TId>> {
  const repository = resolve(locateGitRoot(options.repository));
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxMemories = options.maxMemories ?? 5;
  const maxAgentAttempts = options.maxAgentAttempts ?? DEFAULT_MAX_AGENT_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retryWait = options.retryWait ?? waitForRetry;
  const contextBudgetChars = validateHostContextBudget(
    options.contextBudgetChars ?? HOST_CONTEXT_DEFAULT_BUDGET_CHARS,
  );
  if (!options.task.trim()) throw new RepoMindError("INVALID_INPUT", "--task is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RepoMindError("INVALID_INPUT", `Invalid timeout ${timeoutMs}`);
  if (!Number.isInteger(maxMemories) || maxMemories < 0 || maxMemories > 20) {
    throw new RepoMindError("INVALID_INPUT", `maxMemories must be an integer between 0 and 20; received ${maxMemories}`);
  }
  if (!Number.isInteger(maxAgentAttempts) || maxAgentAttempts < 1 || maxAgentAttempts > MAX_AGENT_ATTEMPTS) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `maxAgentAttempts must be an integer between 1 and ${MAX_AGENT_ATTEMPTS}; received ${maxAgentAttempts}`,
    );
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_RETRY_DELAY_MS) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `retryDelayMs must be an integer between 0 and ${MAX_RETRY_DELAY_MS}; received ${retryDelayMs}`,
    );
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
    const renderedContext = renderHostContext({
      task: options.task,
      memories: started.result.memories,
      moduleNarratives: started.result.moduleNarratives ?? [],
      repositoryProfile: started.result.repositoryProfile,
      budgetChars: contextBudgetChars,
    });
    const agentRequest = {
      repository,
      prompt: renderedContext.prompt,
      model: options.model ?? null,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    };
    options.adapter.validate(agentRequest);
    beginHostRunLifecycle(repository, options.dataDirectory, {
      sessionId: started.sessionId,
      task: options.task,
      runner: options.adapter.id,
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
    options.onStatus?.(
      `Running ${options.adapter.displayName} with ${renderedContext.stats.l1.injected} L1, ${renderedContext.stats.l2.injected} L2, and ${renderedContext.stats.l3.injected} L3 context records...`,
    );
    const attempts: AgentHostAttemptReport[] = [];
    let execution: AgentHostRunResult | null = null;
    let executionMode: AgentHostAttemptMode = "fresh";
    let continuationToken: string | undefined;
    for (let attempt = 1; attempt <= maxAgentAttempts; attempt++) {
      const snapshotBefore = inspectGit(repository);
      const attemptStartedAt = new Date().toISOString();
      const currentExecution = executionMode === "resume"
        ? await options.adapter.resume!(agentRequest, continuationToken!)
        : await options.adapter.run(agentRequest);
      const attemptEndedAt = new Date().toISOString();
      const snapshotAfter = inspectGit(repository);
      const assessment = assessAgentInfrastructureRetry({
        execution: currentExecution,
        snapshotBefore,
        snapshotAfter,
        attemptMode: executionMode,
        ...(options.adapter.resume ? { resumeSupported: true } : {}),
        ...(options.signal?.aborted === true ? { hostSignalAborted: true } : {}),
      });
      const scheduled = assessment.eligible && attempt < maxAgentAttempts;
      const attemptDirectory = join(outputDirectory, "attempts", `attempt-${String(attempt).padStart(2, "0")}`);
      mkdirSync(attemptDirectory, { recursive: true });
      const stdoutPath = join(attemptDirectory, "stdout.log");
      const attemptStderrPath = join(attemptDirectory, "stderr.log");
      const redactedStdout = redactSecrets(currentExecution.process.stdout);
      const redactedAttemptStderr = redactSecrets(currentExecution.process.stderr);
      writeFileSync(stdoutPath, redactedStdout.content, "utf8");
      writeFileSync(attemptStderrPath, redactedAttemptStderr.content, "utf8");
      attempts.push({
        attempt,
        executionMode,
        startedAt: attemptStartedAt,
        endedAt: attemptEndedAt,
        artifacts: { stdout: stdoutPath, stderr: attemptStderrPath },
        git: {
          before: snapshotBefore,
          after: snapshotAfter,
          unchanged: assessment.conditions.repositoryUnchanged,
        },
        process: {
          exitCode: currentExecution.process.exitCode,
          signal: currentExecution.process.signal,
          durationMs: currentExecution.process.durationMs,
          timedOut: currentExecution.process.timedOut,
          aborted: currentExecution.process.aborted,
          error: currentExecution.process.error ?? null,
          stdoutTruncated: currentExecution.process.stdoutTruncated,
          stderrTruncated: currentExecution.process.stderrTruncated,
        },
        outcome: currentExecution.outcome,
        events: currentExecution.events,
        retry: {
          ...assessment,
          scheduled,
          delayMs: scheduled ? retryDelayMs : null,
        },
        redactions: {
          stdout: redactedStdout.redactions,
          stderr: redactedAttemptStderr.redactions,
        },
      });
      execution = currentExecution;
      if (!scheduled) break;
      const nextMode: AgentHostAttemptMode = assessment.mode === "resume" ? "resume" : "fresh";
      if (nextMode === "resume") {
        continuationToken = currentExecution.continuationToken!;
        options.onStatus?.(
          `${options.adapter.displayName} attempt ${attempt}/${maxAgentAttempts} hit a transient ${assessment.matchedSignals.join(", ")} failure after resume-safe local activity; resuming the existing provider session in ${retryDelayMs}ms...`,
        );
      } else {
        continuationToken = undefined;
        options.onStatus?.(
          `${options.adapter.displayName} attempt ${attempt}/${maxAgentAttempts} hit a transient ${assessment.matchedSignals.join(", ")} failure before repository activity; starting a fresh attempt in ${retryDelayMs}ms...`,
        );
      }
      executionMode = nextMode;
      await retryWait(retryDelayMs);
    }
    if (!execution) throw new Error("Agent process did not produce an attempt result");
    const agent = execution.process;
    const retries = attempts.filter((attempt) => attempt.retry.scheduled).length;
    const agentDurationMs = attempts.reduce(
      (total, attempt) => total + attempt.process.durationMs + (attempt.retry.delayMs ?? 0),
      0,
    );
    const interrupted = agent.timedOut || agent.aborted || agent.signal !== null || agent.error !== undefined || agent.exitCode === null;
    const outcome = execution.outcome;
    const eventMetrics = aggregateAgentEventMetrics(attempts.map((attempt) => attempt.events));
    const verificationSnapshotBefore = interrupted || !options.verify ? null : inspectGit(repository);
    const verified = interrupted || !options.verify
      ? { checks: [] as readonly TestEvidenceInput[], evidence: [] as readonly TestEvidenceInput[] }
      : verificationResult(await options.verify(repository));
    const authoritativeChecks = [...verified.checks];
    const persistedCheckEvidence = [...verified.evidence];
    const verificationSnapshotAfter = verificationSnapshotBefore ? inspectGit(repository) : null;
    const verificationSnapshotStable = verificationSnapshotBefore && verificationSnapshotAfter
      ? JSON.stringify(verificationSnapshotBefore) === JSON.stringify(verificationSnapshotAfter)
      : undefined;
    const quality = assessAgentOutcome({
      agentExitCode: agent.exitCode,
      commands: outcome.commands,
      authoritativeChecks,
      ...(authoritativeChecks.length ? {
        authoritativeVerificationAuthority: options.verificationAuthority ?? "host-config",
      } : {}),
      ...(verificationSnapshotStable === undefined ? {} : { verificationSnapshotStable }),
      trace: outcome.trace,
      stdoutTruncated: agent.stdoutTruncated,
      repoMindCalls: eventMetrics.repoMindCalls,
    });
    let committed: CommitSessionResult | null = null;
    let commitMs: number | null = null;
    let maintenanceMs: number | null = null;
    let maintenance: DerivedMaintenanceResult | null = null;
    let maintenanceBefore: DerivedLayerSnapshot | null = null;
    let maintenanceAfter: DerivedLayerSnapshot | null = null;
    let maintenanceTelemetryErrors: string[] = [];
    let sessionStatus: AgentHostRunReport<TId>["session"]["status"];
    if (interrupted) {
      options.onStatus?.(`${options.adapter.displayName} did not complete normally; abandoning RepoMind session...`);
      abandonMs = abandonHostLifecycle(repository, started.sessionId, options.dataDirectory).abandonMs;
      sessionClosed = true;
      sessionStatus = "abandoned";
    } else {
      options.onStatus?.("Committing Agent evidence to RepoMind...");
      const commands = outcome.commands.map(({ isTest: _isTest, exitCodeKnown: _exitCodeKnown, ...command }) => command);
      const commit = commitHostLifecycle({
        repository,
        ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
        sessionId: started.sessionId,
        idempotencyKey: `${options.adapter.id}-host-${started.sessionId}`,
        status: quality.status,
        summary: outcome.summary,
        tests: persistedCheckEvidence,
        commands,
      });
      committed = commit.result;
      commitMs = commit.commitMs;
      maintenanceMs = commit.maintenanceMs;
      maintenance = commit.maintenance;
      maintenanceBefore = commit.maintenanceBefore;
      maintenanceAfter = commit.maintenanceAfter;
      maintenanceTelemetryErrors = commit.maintenanceTelemetryErrors;
      sessionClosed = true;
      sessionStatus = commit.result.status as AgentHostRunReport<TId>["session"]["status"];
    }

    const redactedEvents = redactSecrets(agent.stdout);
    const redactedStderr = redactSecrets(agent.stderr);
    writeFileSync(eventsPath, redactedEvents.content, "utf8");
    writeFileSync(stderrPath, redactedStderr.content, "utf8");
    const rawReport = {
      version: 3 as const,
      runId: started.sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      repository,
      task: options.task,
      runner: options.adapter.id,
      model: options.model ?? null,
      outputDirectory,
      artifacts: { events: eventsPath, stderr: stderrPath, report: reportPath },
      session: {
        id: started.sessionId,
        status: sessionStatus,
        retrievedMemories: started.result.memories.length,
        retrievedMemoryIds: started.result.memories.map((memory) => memory.id),
        retrievedModuleNarratives: started.result.moduleNarratives?.length ?? 0,
        retrievedModuleNarrativeIds: (started.result.moduleNarratives ?? []).map((narrative) => narrative.id),
        retrievedModuleNarrativeVersions: (started.result.moduleNarratives ?? []).map((narrative) => ({
          id: narrative.id,
          version: narrative.version,
        })),
        repositoryProfileId: started.result.repositoryProfile?.id ?? null,
        repositoryProfileVersion: started.result.repositoryProfile?.version ?? null,
        retrievalStrategy: started.result.retrievalStrategy ?? null,
        retrievalFallbackReason: started.result.retrievalFallbackReason ?? null,
        startMs: started.startMs,
        commitMs,
        maintenanceMs,
        abandonMs,
      },
      context: renderedContext.stats,
      retry: {
        maxAttempts: maxAgentAttempts,
        delayMs: retryDelayMs,
        attempts: attempts.length,
        retries,
        exhausted: attempts.length === maxAgentAttempts && attempts.at(-1)?.retry.eligible === true,
      },
      attempts,
      agent: {
        exitCode: agent.exitCode,
        signal: agent.signal,
        durationMs: agentDurationMs,
        timedOut: agent.timedOut,
        aborted: agent.aborted,
        error: agent.error ?? null,
        stdoutTruncated: agent.stdoutTruncated,
        stderrTruncated: agent.stderrTruncated,
        events: eventMetrics,
      },
      quality,
      commit: committed,
      maintenance: summarizeDerivedMaintenance(
        maintenance,
        maintenanceBefore,
        maintenanceAfter,
        maintenanceTelemetryErrors,
      ),
      summary: outcome.summary,
      succeeded: agent.exitCode === 0 && committed?.status === "committed",
    };
    const redactedReport = redactDeep(rawReport);
    const report: AgentHostRunReport<TId> = {
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
        maintenanceMs: report.session.maintenanceMs,
        abandonMs: report.session.abandonMs,
        context: report.context,
        maintenance: report.maintenance,
        quality: report.quality,
        retry: report.retry,
        redactions: report.redactions,
        retrievedMemoryIds: report.session.retrievedMemoryIds,
        retrievedModuleNarrativeIds: report.session.retrievedModuleNarrativeIds,
        retrievedModuleNarrativeVersions: report.session.retrievedModuleNarrativeVersions,
        repositoryProfileId: report.session.repositoryProfileId,
        repositoryProfileVersion: report.session.repositoryProfileVersion,
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
