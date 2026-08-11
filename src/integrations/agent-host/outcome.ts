import { assessOpenCodeOutcome, type HostOutcomeAssessment } from "../opencode/lifecycle.js";
import type { AgentCommandEvidence, AgentTraceAssessment } from "./types.js";

export interface AssessAgentOutcomeInput {
  agentExitCode: number | null;
  commands: readonly AgentCommandEvidence[];
  authoritativeChecks?: ReadonlyArray<{ exitCode: number | null }>;
  authoritativeVerificationAuthority?: "host-config" | "benchmark-manifest";
  verificationSnapshotStable?: boolean;
  trace?: AgentTraceAssessment;
  stdoutTruncated?: boolean;
  repoMindCalls?: number;
}

export type AgentOutcomeAssessment = HostOutcomeAssessment;

export function assessAgentOutcome(input: AssessAgentOutcomeInput): AgentOutcomeAssessment {
  return assessOpenCodeOutcome(input);
}
