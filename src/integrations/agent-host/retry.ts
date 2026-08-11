import type { GitSnapshot } from "../../domain/types.js";
import type {
  AgentInfrastructureFailureSignal,
  AgentInfrastructureRetryAssessment,
  AgentInfrastructureRetryInput,
} from "./types.js";

const TRANSIENT_PATTERNS: ReadonlyArray<{
  signal: AgentInfrastructureFailureSignal;
  patterns: readonly RegExp[];
}> = [
  {
    signal: "tls-certificate",
    patterns: [
      /\bunknown certificate verification error\b/iu,
      /\bcertificate (?:verification|verify) (?:error|failed|failure)\b/iu,
      /\bunable to verify (?:the )?(?:first |leaf )?certificate\b/iu,
      /\bself[- ]signed certificate\b/iu,
      /\b(?:cert_has_expired|unable_to_verify_leaf_signature|err_tls_cert_altname_invalid)\b/iu,
      /\b(?:tls|ssl)\b.{0,80}\b(?:handshake|certificate)\b.{0,40}\b(?:error|failed|failure)\b/iu,
    ],
  },
  {
    signal: "connection-reset",
    patterns: [
      /\b(?:econnreset|connection reset(?: by peer)?|socket hang up)\b/iu,
    ],
  },
  {
    signal: "network-timeout",
    patterns: [
      /\b(?:etimedout|esockettimedout|deadline exceeded)\b/iu,
      /\b(?:request|connect(?:ion)?|network|upstream|gateway)\s+(?:timed?\s*out|timeout)\b/iu,
    ],
  },
  {
    signal: "http-429",
    patterns: [
      /\b(?:http(?:\/[0-9.]+)?\s+|status(?:[_ -]*code)?\s*[:=]?\s*)429\b/iu,
      /\b(?:too many requests|rate limit(?:ed| exceeded)?)\b/iu,
    ],
  },
  {
    signal: "http-5xx",
    patterns: [
      /\b(?:http(?:\/[0-9.]+)?\s+(?:status(?:[_ -]*code)?\s*)?|status(?:[_ -]*code)?\s*[:=]?\s*)5\d\d\b/iu,
      /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/iu,
    ],
  },
  {
    signal: "upstream-http2-stream",
    patterns: [
      /\bupstream_http2_stream_error\b/iu,
      /\bupstream HTTP\/2 stream failed\b/iu,
      /\bupstream_stream_read_error\b/iu,
      /\bupstream response stream was interrupted\b/iu,
    ],
  },
];

const RESUME_SAFE_TOOLS = new Set([
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "list",
  "read",
  "todowrite",
  "write",
]);

function snapshotsEqual(left: GitSnapshot, right: GitSnapshot): boolean {
  return left.branch === right.branch
    && left.head === right.head
    && left.dirty === right.dirty
    && left.status === right.status;
}

function transientSignals(text: string): AgentInfrastructureFailureSignal[] {
  return TRANSIENT_PATTERNS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ signal }) => signal);
}

function totalToolCalls(toolCalls: Readonly<Record<string, number>>): number {
  return Object.values(toolCalls).reduce((sum, count) => sum + count, 0);
}

export function assessAgentInfrastructureRetry(
  input: AgentInfrastructureRetryInput,
): AgentInfrastructureRetryAssessment {
  const { execution } = input;
  const process = execution.process;
  const abnormalExitOrTerminal = process.exitCode === null
    || process.exitCode !== 0
    || process.error !== undefined
    || execution.outcome.trace.terminal !== "clean-stop";
  const zeroInputOutputTokens = execution.events.tokens.input === 0
    && execution.events.tokens.output === 0;
  const zeroAgentActivity = totalToolCalls(execution.events.toolCalls) === 0
    && execution.outcome.commands.length === 0
    && execution.events.repoMindCalls === 0;
  const repositoryUnchanged = snapshotsEqual(input.snapshotBefore, input.snapshotAfter);
  const interruptFree = !process.timedOut
    && !process.aborted
    && process.signal === null
    && input.hostSignalAborted !== true;
  const diagnosticText = [process.stdout, process.stderr, execution.outcome.summary].join("\n");
  const matchedSignals = transientSignals(diagnosticText);
  const transientFailureMatched = matchedSignals.length > 0;
  const upstreamStreamFailure = matchedSignals.includes("upstream-http2-stream");
  const resumeSupported = input.resumeSupported === true;
  const resumeTokenAvailable = Boolean(execution.continuationToken?.trim());
  const noCommandActivity = execution.outcome.commands.length === 0;
  const noRepoMindActivity = execution.events.repoMindCalls === 0;
  const resumeSafeTools = Object.entries(execution.events.toolCalls)
    .filter(([, count]) => count > 0)
    .every(([tool]) => RESUME_SAFE_TOOLS.has(tool.toLowerCase()));
  const conditions = {
    abnormalExitOrTerminal,
    zeroInputOutputTokens,
    zeroAgentActivity,
    repositoryUnchanged,
    interruptFree,
    transientFailureMatched,
    upstreamStreamFailure,
    resumeSupported,
    resumeTokenAvailable,
    noCommandActivity,
    noRepoMindActivity,
    resumeSafeTools,
  };
  const freshConditions = {
    abnormalExitOrTerminal,
    zeroInputOutputTokens,
    zeroAgentActivity,
    repositoryUnchanged,
    interruptFree,
    transientFailureMatched,
  };
  const freshLabels: Record<keyof typeof freshConditions, string> = {
    abnormalExitOrTerminal: "agent-exit-and-terminal-were-normal",
    zeroInputOutputTokens: "agent-produced-input-or-output-tokens",
    zeroAgentActivity: "agent-observed-tools-commands-or-repomind-calls",
    repositoryUnchanged: "repository-changed-during-attempt",
    interruptFree: "attempt-was-aborted-signaled-or-host-timed-out",
    transientFailureMatched: "no-explicit-transient-infrastructure-signal",
  };
  const freshBlockers = (Object.keys(freshConditions) as Array<keyof typeof freshConditions>)
    .filter((condition) => !freshConditions[condition])
    .map((condition) => freshLabels[condition]);
  const resumeConditions = {
    abnormalExitOrTerminal,
    interruptFree,
    upstreamStreamFailure,
    resumeSupported,
    resumeTokenAvailable,
    noCommandActivity,
    noRepoMindActivity,
    resumeSafeTools,
  };
  const resumeLabels: Record<keyof typeof resumeConditions, string> = {
    abnormalExitOrTerminal: "agent-exit-and-terminal-were-normal",
    interruptFree: "attempt-was-aborted-signaled-or-host-timed-out",
    upstreamStreamFailure: "failure-is-not-upstream-http2-stream",
    resumeSupported: "adapter-does-not-support-session-resume",
    resumeTokenAvailable: "missing-provider-session-token",
    noCommandActivity: "agent-observed-shell-or-command-activity",
    noRepoMindActivity: "agent-observed-repomind-activity",
    resumeSafeTools: "agent-observed-nonlocal-or-unsupported-tools",
  };
  const resumeBlockers = (Object.keys(resumeConditions) as Array<keyof typeof resumeConditions>)
    .filter((condition) => !resumeConditions[condition])
    .map((condition) => resumeLabels[condition]);
  const freshEligible = freshBlockers.length === 0;
  const resumeEligible = resumeBlockers.length === 0;
  const mode = input.attemptMode === "resume"
    ? resumeEligible ? "resume" : "none"
    : freshEligible
      ? "fresh"
      : resumeEligible
        ? "resume"
        : "none";
  return {
    eligible: mode !== "none",
    mode,
    matchedSignals,
    conditions,
    blockers: mode === "none"
      ? (input.attemptMode === "resume" || upstreamStreamFailure ? resumeBlockers : freshBlockers)
      : [],
  };
}
