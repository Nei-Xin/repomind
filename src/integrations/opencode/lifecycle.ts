import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import type {
  CommitSessionResult,
  DerivedMaintenanceError,
  DerivedMaintenanceResult,
  MemoryResult,
  ModuleNarrativeSummary,
  RepositoryProfileSummary,
  SkillCandidateSummary,
  StartSessionResult,
  TestEvidenceInput,
} from "../../domain/types.js";
import type { BeginHostRunInput, FinishHostRunInput, HostRunRecord } from "../../domain/types.js";
import { RepoMindError } from "../../errors.js";
import { renderHostContext } from "./context.js";

export interface HostLifecycleStart {
  sessionId: string;
  startMs: number;
  result: StartSessionResult;
}

export interface OpenCodeCommandEvidence extends TestEvidenceInput {
  isTest: boolean;
  exitCodeKnown: boolean;
}

export interface OpenCodeTraceAssessment {
  parsedEvents: number;
  malformedLines: number;
  explicitErrors: number;
  unknownCommandResults: number;
  terminal: "clean-stop" | "explicit-error" | "incomplete";
}

export interface OpenCodeOutcome {
  summary: string;
  commands: OpenCodeCommandEvidence[];
  trace: OpenCodeTraceAssessment;
}

export type HostOutcomeQualityFlag =
  | "recovered-command-failure"
  | "unrecovered-command-failure"
  | "authoritative-verification-failed"
  | "authoritative-verification-unavailable"
  | "verification-snapshot-changed"
  | "malformed-agent-events"
  | "explicit-agent-error"
  | "incomplete-agent-trace"
  | "unknown-command-result"
  | "output-truncated"
  | "agent-protocol-violation";

export interface HostOutcomeAssessment {
  completion: "clean" | "recovered" | "inconclusive" | "failed";
  status: "success" | "partial" | "failed";
  maintenanceEligible: boolean;
  qualityFlags: HostOutcomeQualityFlag[];
  commands: {
    observed: number;
    failed: number;
    recovered: number;
    unrecovered: number;
  };
  authoritativeVerification: {
    authority: "none" | "host-config" | "benchmark-manifest";
    checks: number;
    passed: boolean | null;
    snapshotStable: boolean | null;
  };
  trace: OpenCodeTraceAssessment;
}

export interface HostLifecycleCommit {
  commitMs: number;
  result: CommitSessionResult;
  maintenanceMs: number | null;
  maintenance: DerivedMaintenanceResult | null;
  maintenanceBefore: DerivedLayerSnapshot | null;
  maintenanceAfter: DerivedLayerSnapshot | null;
  maintenanceTelemetryErrors: string[];
}

export interface DerivedLayerSnapshot {
  l2: Array<{ id: string; modulePath: string; version: number; current: boolean }>;
  l3: { id: string; version: number; current: boolean } | null;
  l4: Array<{ id: string; status: SkillCandidateSummary["status"] }>;
}

export interface HostLifecycleAbandon {
  abandonMs: number;
}

const MAX_HOST_SUMMARY_CHARS = 12_000;
const SUMMARY_TRUNCATION_MARKER = "\n[truncated by RepoMind host]";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function boundedHostSummary(value: string): string {
  const sanitized = value.replace(/\u0000/gu, "");
  if (sanitized.length <= MAX_HOST_SUMMARY_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_HOST_SUMMARY_CHARS - SUMMARY_TRUNCATION_MARKER.length).trimEnd()}${SUMMARY_TRUNCATION_MARKER}`;
}

function unexpectedMaintenanceFailure(error: unknown, durationMs: number): DerivedMaintenanceResult {
  const failure: DerivedMaintenanceError = error instanceof RepoMindError
    ? { code: error.code, message: error.message, details: error.details ?? null }
    : {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        details: null,
      };
  const stage = {
    status: "failed" as const,
    durationMs: 0,
    result: null,
    error: failure,
    reason: null,
  };
  return { status: "failed", durationMs, l2: stage, l3: stage, l4: stage };
}

function coreOptions(dataDirectory: string | undefined): { dataDirectory?: string } {
  return dataDirectory === undefined ? {} : { dataDirectory };
}

function captureDerivedLayerSnapshot(core: RepositoryMemoryCore): DerivedLayerSnapshot {
  const profile = core.getRepositoryProfile();
  return {
    l2: core.listModuleNarratives().map((narrative) => ({
      id: narrative.id,
      modulePath: narrative.modulePath,
      version: narrative.version,
      current: narrative.current,
    })),
    l3: profile ? { id: profile.id, version: profile.version, current: profile.current } : null,
    l4: core.listSkillCandidates().map((candidate) => ({ id: candidate.id, status: candidate.status })),
  };
}

function tryDerivedLayerSnapshot(
  core: RepositoryMemoryCore,
  phase: "before" | "after",
): { snapshot: DerivedLayerSnapshot | null; error: string | null } {
  try {
    return { snapshot: captureDerivedLayerSnapshot(core), error: null };
  } catch (error) {
    return { snapshot: null, error: `${phase}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function startHostLifecycle(
  repository: string,
  task: string,
  dataDirectory?: string,
  maxMemories = 5,
): Promise<HostLifecycleStart> {
  const started = performance.now();
  const core = new RepositoryMemoryCore(repository, coreOptions(dataDirectory));
  let result: StartSessionResult;
  try {
    result = await core.startSessionHybrid({ task, clientName: "opencode-host", maxMemories });
  } finally {
    core.close();
  }
  return { sessionId: result.sessionId, startMs: round(performance.now() - started), result };
}

export function commitHostLifecycle(input: {
  repository: string;
  dataDirectory?: string;
  sessionId: string;
  idempotencyKey: string;
  status: "success" | "partial" | "failed";
  summary: string;
  tests?: TestEvidenceInput[];
  commands?: TestEvidenceInput[];
}): HostLifecycleCommit {
  const core = new RepositoryMemoryCore(input.repository, coreOptions(input.dataDirectory));
  try {
    const commitStarted = performance.now();
    const result = core.commitSession({
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      summary: input.summary,
      ...(input.tests?.length ? { tests: input.tests } : {}),
      ...(input.commands?.length ? { commands: input.commands } : {}),
    });
    const commitMs = round(performance.now() - commitStarted);
    if (result.status !== "committed") {
      return {
        commitMs,
        result,
        maintenanceMs: null,
        maintenance: null,
        maintenanceBefore: null,
        maintenanceAfter: null,
        maintenanceTelemetryErrors: [],
      };
    }
    const before = tryDerivedLayerSnapshot(core, "before");
    const maintenanceStarted = performance.now();
    let maintenance: DerivedMaintenanceResult;
    try {
      maintenance = core.maintainDerivedLayers();
    } catch (error) {
      maintenance = unexpectedMaintenanceFailure(error, round(performance.now() - maintenanceStarted));
    }
    const after = tryDerivedLayerSnapshot(core, "after");
    return {
      commitMs,
      result,
      maintenanceMs: round(performance.now() - maintenanceStarted),
      maintenance,
      maintenanceBefore: before.snapshot,
      maintenanceAfter: after.snapshot,
      maintenanceTelemetryErrors: [before.error, after.error].filter((error): error is string => error !== null),
    };
  } finally {
    core.close();
  }
}

export function abandonHostLifecycle(
  repository: string,
  sessionId: string,
  dataDirectory?: string,
): HostLifecycleAbandon {
  const started = performance.now();
  const core = new RepositoryMemoryCore(repository, coreOptions(dataDirectory));
  try {
    core.abandonSession(sessionId);
  } finally {
    core.close();
  }
  return { abandonMs: round(performance.now() - started) };
}

export function beginHostRunLifecycle(
  repository: string,
  dataDirectory: string | undefined,
  input: BeginHostRunInput,
): HostRunRecord {
  const core = new RepositoryMemoryCore(repository, coreOptions(dataDirectory));
  try {
    return core.beginHostRun(input);
  } finally {
    core.close();
  }
}

export function finishHostRunLifecycle(
  repository: string,
  dataDirectory: string | undefined,
  input: FinishHostRunInput,
): HostRunRecord {
  const core = new RepositoryMemoryCore(repository, coreOptions(dataDirectory));
  try {
    return core.finishHostRun(input);
  } finally {
    core.close();
  }
}

export function hostManagedPrompt(
  task: string,
  memories: readonly MemoryResult[],
  moduleNarratives: readonly ModuleNarrativeSummary[] = [],
  repositoryProfile?: RepositoryProfileSummary,
  budgetChars?: number,
): string {
  return renderHostContext({
    task,
    memories,
    moduleNarratives,
    repositoryProfile,
    ...(budgetChars === undefined ? {} : { budgetChars }),
  }).prompt;
}

export function assessOpenCodeOutcome(input: {
  agentExitCode: number | null;
  commands: readonly OpenCodeCommandEvidence[];
  authoritativeChecks?: ReadonlyArray<{ exitCode: number | null }>;
  authoritativeVerificationAuthority?: "host-config" | "benchmark-manifest";
  verificationSnapshotStable?: boolean;
  trace?: OpenCodeTraceAssessment;
  stdoutTruncated?: boolean;
  repoMindCalls?: number;
}): HostOutcomeAssessment {
  const failed = input.commands.filter((command) => command.exitCode !== 0).length;
  const authoritativeChecks = input.authoritativeChecks ?? [];
  const authoritativePassed = !authoritativeChecks.length
    ? null
    : authoritativeChecks.some((check) => check.exitCode !== null && check.exitCode !== 0)
      ? false
      : authoritativeChecks.some((check) => check.exitCode === null)
        ? null
        : true;
  const trace = input.trace ?? {
    parsedEvents: 0,
    malformedLines: 0,
    explicitErrors: 0,
    unknownCommandResults: 0,
    terminal: "clean-stop" as const,
  };
  const traceIncomplete = trace.malformedLines > 0
    || trace.explicitErrors > 0
    || trace.unknownCommandResults > 0
    || trace.terminal !== "clean-stop";
  const protocolViolation = (input.repoMindCalls ?? 0) > 0;
  const verificationUnavailable = authoritativeChecks.length > 0 && authoritativePassed === null;
  const verificationSnapshotChanged = authoritativeChecks.length > 0 && input.verificationSnapshotStable !== true;
  const recoveryAuthorized = failed > 0
    && authoritativePassed === true
    && input.verificationSnapshotStable === true
    && !traceIncomplete
    && !input.stdoutTruncated
    && !protocolViolation;
  const recovered = recoveryAuthorized ? failed : 0;
  const unrecovered = failed - recovered;
  const qualityFlags: HostOutcomeQualityFlag[] = [];
  if (recovered > 0) qualityFlags.push("recovered-command-failure");
  if (unrecovered > 0) qualityFlags.push("unrecovered-command-failure");
  if (authoritativePassed === false) qualityFlags.push("authoritative-verification-failed");
  if (verificationUnavailable) qualityFlags.push("authoritative-verification-unavailable");
  if (verificationSnapshotChanged) qualityFlags.push("verification-snapshot-changed");
  if (trace.malformedLines > 0) qualityFlags.push("malformed-agent-events");
  if (trace.explicitErrors > 0 || trace.terminal === "explicit-error") qualityFlags.push("explicit-agent-error");
  if (trace.terminal === "incomplete") qualityFlags.push("incomplete-agent-trace");
  if (trace.unknownCommandResults > 0) qualityFlags.push("unknown-command-result");
  if (input.stdoutTruncated) qualityFlags.push("output-truncated");
  if ((input.repoMindCalls ?? 0) > 0) qualityFlags.push("agent-protocol-violation");
  let completion: HostOutcomeAssessment["completion"];
  let status: HostOutcomeAssessment["status"];
  if (input.agentExitCode !== 0 || authoritativePassed === false) {
    completion = "failed";
    status = "failed";
  } else if (
    unrecovered > 0
    || verificationUnavailable
    || verificationSnapshotChanged
    || traceIncomplete
    || input.stdoutTruncated
    || protocolViolation
  ) {
    completion = "inconclusive";
    status = "partial";
  } else {
    completion = recovered > 0 ? "recovered" : "clean";
    status = "success";
  }
  return {
    completion,
    status,
    maintenanceEligible: status === "success",
    qualityFlags,
    commands: { observed: input.commands.length, failed, recovered, unrecovered },
    authoritativeVerification: {
      authority: authoritativeChecks.length ? input.authoritativeVerificationAuthority ?? "host-config" : "none",
      checks: authoritativeChecks.length,
      passed: authoritativePassed,
      snapshotStable: authoritativeChecks.length ? input.verificationSnapshotStable ?? null : null,
    },
    trace,
  };
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(test|tests|vitest|jest|pytest|unittest|mocha)(\s|$)|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/iu.test(command);
}

export function analyzeOpenCodeOutcome(jsonl: string, fallbackSummary: string): OpenCodeOutcome {
  let summary = "";
  const commands: OpenCodeCommandEvidence[] = [];
  let parsedEvents = 0;
  let malformedLines = 0;
  let explicitErrors = 0;
  let lastEvent: Record<string, unknown> | undefined;
  for (const line of jsonl.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (!line.trim().startsWith("{")) {
      malformedLines += 1;
      continue;
    }
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch {
      malformedLines += 1;
      continue;
    }
    parsedEvents += 1;
    lastEvent = event;
    if (event.type === "error") explicitErrors += 1;
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "text" && typeof part?.text === "string" && part.text.trim()) summary = part.text.trim();
    if (event.type !== "tool_use" || (part?.tool !== "bash" && part?.tool !== "shell")) continue;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const input = state.input as Record<string, unknown> | undefined;
    const metadata = state.metadata as Record<string, unknown> | undefined;
    if (typeof input?.command !== "string" || !input.command.trim()) continue;
    const output = typeof state.output === "string" ? state.output.trim() : "";
    const exitCodeKnown = Number.isInteger(metadata?.exit);
    commands.push({
      command: input.command.trim(),
      exitCode: exitCodeKnown ? Number(metadata?.exit) : 1,
      exitCodeKnown,
      summary: output.slice(0, 2000),
      isTest: isTestCommand(input.command),
    });
  }
  const lastPart = lastEvent?.part as Record<string, unknown> | undefined;
  const terminal = explicitErrors > 0
    ? "explicit-error"
    : lastEvent?.type === "step_finish" && lastPart?.reason === "stop"
      ? "clean-stop"
      : "incomplete";
  return {
    summary: boundedHostSummary(summary || fallbackSummary),
    commands,
    trace: {
      parsedEvents,
      malformedLines,
      explicitErrors,
      unknownCommandResults: commands.filter((command) => !command.exitCodeKnown).length,
      terminal,
    },
  };
}
