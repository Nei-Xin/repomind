import type { GitSnapshot, TestEvidenceInput } from "../../domain/types.js";
import type { AgentEventMetrics } from "../../eval/agent/events.js";

export interface AgentProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface AgentProcessResult {
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

export type AgentProcessExecutor = (request: AgentProcessRequest) => Promise<AgentProcessResult>;

export interface AgentCommandEvidence extends TestEvidenceInput {
  isTest: boolean;
  exitCodeKnown: boolean;
}

export interface AgentTraceAssessment {
  parsedEvents: number;
  malformedLines: number;
  explicitErrors: number;
  unknownCommandResults: number;
  terminal: "clean-stop" | "explicit-error" | "incomplete";
}

export interface AgentOutcome {
  summary: string;
  commands: AgentCommandEvidence[];
  trace: AgentTraceAssessment;
}

export interface AgentHostRunRequest {
  repository: string;
  prompt: string;
  model: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface AgentHostRunResult {
  process: AgentProcessResult;
  outcome: AgentOutcome;
  events: AgentEventMetrics;
  /** Provider-owned session token used only for an adapter-supported continuation. */
  continuationToken?: string;
}

export type AgentInfrastructureFailureSignal =
  | "tls-certificate"
  | "connection-reset"
  | "network-timeout"
  | "http-429"
  | "http-5xx"
  | "upstream-http2-stream";

export type AgentInfrastructureRetryMode = "none" | "fresh" | "resume";
export type AgentHostAttemptMode = Exclude<AgentInfrastructureRetryMode, "none">;

export interface AgentInfrastructureRetryConditions {
  abnormalExitOrTerminal: boolean;
  zeroInputOutputTokens: boolean;
  zeroAgentActivity: boolean;
  repositoryUnchanged: boolean;
  interruptFree: boolean;
  transientFailureMatched: boolean;
  upstreamStreamFailure: boolean;
  resumeSupported: boolean;
  resumeTokenAvailable: boolean;
  noCommandActivity: boolean;
  noRepoMindActivity: boolean;
  resumeSafeTools: boolean;
}

export interface AgentInfrastructureRetryAssessment {
  eligible: boolean;
  mode: AgentInfrastructureRetryMode;
  matchedSignals: AgentInfrastructureFailureSignal[];
  conditions: AgentInfrastructureRetryConditions;
  blockers: string[];
}

export interface AgentInfrastructureRetryInput {
  execution: AgentHostRunResult;
  snapshotBefore: GitSnapshot;
  snapshotAfter: GitSnapshot;
  hostSignalAborted?: boolean;
  resumeSupported?: boolean;
  attemptMode?: AgentHostAttemptMode;
}

export interface AgentHostAdapter<TId extends string = string> {
  readonly id: TId;
  readonly displayName: string;
  readonly executable: string;
  validate(request: AgentHostRunRequest): void;
  run(request: AgentHostRunRequest): Promise<AgentHostRunResult>;
  /** Continue a provider session. Adapters without durable sessions must omit this capability. */
  resume?(request: AgentHostRunRequest, continuationToken: string): Promise<AgentHostRunResult>;
  version(cwd: string): Promise<string | null>;
}
