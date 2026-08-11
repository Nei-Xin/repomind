import type { HostContextInjectionStats } from "../../integrations/opencode/context.js";
import type { HostOutcomeAssessment } from "../../integrations/opencode/lifecycle.js";
import type { HostRunMaintenanceReport } from "../../integrations/opencode/run.js";
import {
  DEFAULT_MIN_COMPARABLE_PAIR_COVERAGE_RATE,
  type CrossSessionAcceptanceCriteria,
  type CrossSessionRunner,
} from "./cross-session-manifest.js";
import type { AgentEventMetrics } from "./events.js";
import type { CheckResult } from "./report.js";

export type CrossSessionArm = "isolated" | "shared";
export type CrossSessionMetricKey =
  | "hiddenSuccess"
  | "publicSuccess"
  | "hostLifecycleMs"
  | "agentDurationMs"
  | "processAttempts"
  | "inputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "totalPromptTokens"
  | "outputTokens"
  | "fileReads"
  | "retrievedRecords"
  | "contextChars";

export interface CrossSessionMemoryState {
  sessions: number;
  evidence: number;
  memories: number;
  moduleNarratives: number;
  repositoryProfiles: number;
  skillCandidates: number;
  openSessions: number;
  runningHostRuns: number;
}

export interface CrossSessionStageRun {
  sequenceId: string;
  arm: CrossSessionArm;
  iteration: number;
  stageId: string;
  stageIndex: number;
  /** Effective L1 retrieval limit after stage-level and CLI defaults are resolved. */
  maxMemories: number;
  runner: CrossSessionRunner;
  model: string;
  repository: string;
  dataDirectory: string;
  projectId: string;
  requestedCommit: string;
  baseCommit: string;
  previousCheckpointCommit: string | null;
  checkpointCommit: string;
  checkpointTree: string;
  initialWorktreeClean: boolean;
  changedFiles: string[];
  unexpectedChanges: string[];
  publicChecks: CheckResult[];
  hiddenChecks: CheckResult[];
  verificationMs: number;
  lifecycle: {
    sessionId: string;
    status: "committed" | "partial" | "failed" | "abandoned";
    startMs: number;
    agentMs: number;
    commitMs: number | null;
    commitSucceeded: boolean;
    maintenanceMs: number | null;
    hostLifecycleMs: number;
    retrievedMemoryIds: string[];
    retrievedModuleNarrativeIds: string[];
    repositoryProfileId: string | null;
  };
  context: HostContextInjectionStats;
  quality: HostOutcomeAssessment;
  maintenance: HostRunMaintenanceReport | null;
  memoryState: CrossSessionMemoryState;
  events: AgentEventMetrics;
  artifacts: { events: string; stderr: string; report: string };
  agent: {
    attempts: number;
    infrastructureRetries: number;
    retryExhausted: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    error: string | null;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
}

export interface CrossSessionMetric {
  key: CrossSessionMetricKey;
  preferred: "higher" | "lower" | "diagnostic";
  pairs: number;
  isolatedMean: number;
  sharedMean: number;
  meanDelta: number;
  relativeDeltaPercent: number | null;
  confidence95: { low: number; high: number };
  sharedWins: number;
  ties: number;
  sharedLosses: number;
}

export interface CrossSessionAcceptanceCheck {
  id: string;
  passed: boolean;
  measured: number | null;
  target: string;
  detail: string;
}

export interface CrossSessionEvalReport {
  version: 4;
  generatedAt: string;
  name: string;
  runner: CrossSessionRunner | "mixed";
  model: string;
  repeat: number;
  outputDirectory: string;
  provenance: {
    repoMindVersion: string;
    repoMindCommit: string | null;
    repoMindDirty: boolean | null;
    node: string;
    os: { platform: NodeJS.Platform; release: string; arch: string };
    runnerVersions: Partial<Record<CrossSessionRunner, string | null>>;
    manifestSha256: string;
    sequenceBaseCommits: Record<string, string>;
  };
  runs: CrossSessionStageRun[];
  transfer: {
    runsPerArm: number;
    sharedRecallRate: number;
    isolatedRecallRate: number;
    sharedHiddenPassRate: number;
    isolatedHiddenPassRate: number;
    sharedCommitRate: number;
    isolatedCommitRate: number;
  };
  derivedConsumption: {
    runsPerArm: number;
    sharedDerivedRecallRate: number;
    isolatedDerivedRecallRate: number;
    sharedL1RecallRate: number;
    isolatedL1RecallRate: number;
    sharedL2RecallRate: number;
    sharedL3RecallRate: number;
  };
  efficiencyCoverage: {
    totalPairs: number;
    eligiblePairs: number;
    excludedPairs: number;
    rate: number;
  };
  infrastructure: {
    stageRuns: number;
    processAttempts: number;
    retries: number;
    retriedStageRuns: number;
    exhaustedStageRuns: number;
  };
  comparison: CrossSessionMetric[];
  integrity: { passed: boolean; failures: string[] };
  acceptance: {
    status: "not-configured" | "passed" | "failed";
    criteria: CrossSessionAcceptanceCriteria | null;
    checks: CrossSessionAcceptanceCheck[];
  };
}

export interface BuildCrossSessionReportInput {
  name: string;
  repeat: number;
  outputDirectory: string;
  provenance: CrossSessionEvalReport["provenance"];
  runs: CrossSessionStageRun[];
  expected: Array<{
    sequenceId: string;
    stages: Array<{ stageId: string; runner: CrossSessionRunner; model: string; maxMemories?: number }>;
  }>;
  acceptanceCriteria?: CrossSessionAcceptanceCriteria;
}

const METRICS: Array<{ key: CrossSessionMetricKey; preferred: CrossSessionMetric["preferred"] }> = [
  { key: "hiddenSuccess", preferred: "higher" },
  { key: "publicSuccess", preferred: "higher" },
  { key: "hostLifecycleMs", preferred: "lower" },
  { key: "agentDurationMs", preferred: "lower" },
  { key: "processAttempts", preferred: "diagnostic" },
  { key: "inputTokens", preferred: "lower" },
  { key: "cacheReadTokens", preferred: "diagnostic" },
  { key: "cacheWriteTokens", preferred: "diagnostic" },
  { key: "totalPromptTokens", preferred: "lower" },
  { key: "outputTokens", preferred: "lower" },
  { key: "fileReads", preferred: "lower" },
  { key: "retrievedRecords", preferred: "diagnostic" },
  { key: "contextChars", preferred: "diagnostic" },
];

const EFFICIENCY_METRIC_KEYS = new Set<CrossSessionMetricKey>([
  "hostLifecycleMs",
  "agentDurationMs",
  "inputTokens",
  "totalPromptTokens",
  "outputTokens",
  "fileReads",
]);

const round = (value: number): number => Math.round(value * 1000) / 1000;
const mean = (values: readonly number[]): number => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

function recalled(run: CrossSessionStageRun): boolean {
  return run.context.l1.injected + run.context.l2.injected + run.context.l3.injected > 0;
}

function passedChecks(checks: readonly CheckResult[]): boolean {
  return checks.length > 0 && checks.every((check) => check.passed);
}

function passedAllChecks(run: CrossSessionStageRun): boolean {
  return passedChecks(run.publicChecks)
    && passedChecks(run.hiddenChecks)
    && run.quality.authoritativeVerification.passed === true;
}

function metricValue(run: CrossSessionStageRun, key: CrossSessionMetricKey): number {
  switch (key) {
    case "hiddenSuccess": return passedChecks(run.hiddenChecks) ? 1 : 0;
    case "publicSuccess": return passedChecks(run.publicChecks) ? 1 : 0;
    case "hostLifecycleMs": return run.lifecycle.hostLifecycleMs;
    case "agentDurationMs": return run.lifecycle.agentMs;
    case "processAttempts": return run.agent.attempts;
    case "inputTokens": return run.events.tokens.input;
    case "cacheReadTokens": return run.events.tokens.cacheRead;
    case "cacheWriteTokens": return run.events.tokens.cacheWrite;
    case "totalPromptTokens": return run.events.tokens.input + run.events.tokens.cacheRead + run.events.tokens.cacheWrite;
    case "outputTokens": return run.events.tokens.output;
    case "fileReads": return run.events.fileReads;
    case "retrievedRecords": return run.context.l1.injected + run.context.l2.injected + run.context.l3.injected;
    case "contextChars": return run.context.contextChars;
  }
}

function pairedRuns(runs: readonly CrossSessionStageRun[]): Array<{ isolated: CrossSessionStageRun; shared: CrossSessionStageRun }> {
  const groups = new Map<string, CrossSessionStageRun[]>();
  for (const run of runs.filter((entry) => entry.stageIndex > 0)) {
    const key = `${run.sequenceId}\0${run.stageId}\0${run.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].flatMap((group) => {
    const isolated = group.find((run) => run.arm === "isolated");
    const shared = group.find((run) => run.arm === "shared");
    return isolated && shared ? [{ isolated, shared }] : [];
  });
}

function summarizeMetric(
  pairs: Array<{ isolated: CrossSessionStageRun; shared: CrossSessionStageRun }>,
  definition: typeof METRICS[number],
): CrossSessionMetric {
  const isolated = pairs.map((pair) => metricValue(pair.isolated, definition.key));
  const shared = pairs.map((pair) => metricValue(pair.shared, definition.key));
  const deltas = shared.map((value, index) => value - isolated[index]!);
  const meanDelta = mean(deltas);
  const variance = deltas.length > 1
    ? deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1)
    : 0;
  const margin = deltas.length ? 1.96 * Math.sqrt(variance / deltas.length) : 0;
  let sharedWins = 0;
  let ties = 0;
  let sharedLosses = 0;
  for (const delta of deltas) {
    if (delta === 0 || definition.preferred === "diagnostic") ties += 1;
    else if (
      (definition.preferred === "higher" && delta > 0)
      || (definition.preferred === "lower" && delta < 0)
    ) sharedWins += 1;
    else sharedLosses += 1;
  }
  const isolatedMean = mean(isolated);
  return {
    key: definition.key,
    preferred: definition.preferred,
    pairs: pairs.length,
    isolatedMean: round(isolatedMean),
    sharedMean: round(mean(shared)),
    meanDelta: round(meanDelta),
    relativeDeltaPercent: isolatedMean === 0 ? null : round((meanDelta / Math.abs(isolatedMean)) * 100),
    confidence95: { low: round(meanDelta - margin), high: round(meanDelta + margin) },
    sharedWins,
    ties,
    sharedLosses,
  };
}

function integrityFailures(input: BuildCrossSessionReportInput): string[] {
  const failures: string[] = [];
  const expectedKeys = new Set<string>();
  const expectedConfigurations = new Map<string, {
    runner: CrossSessionRunner;
    model: string;
    maxMemories?: number;
  }>();
  for (const sequence of input.expected) for (let iteration = 1; iteration <= input.repeat; iteration += 1) {
    for (const arm of ["isolated", "shared"] as const) for (const stage of sequence.stages) {
      const key = `${sequence.sequenceId}\0${arm}\0${iteration}\0${stage.stageId}`;
      expectedKeys.add(key);
      expectedConfigurations.set(key, {
        runner: stage.runner,
        model: stage.model,
        ...(stage.maxMemories === undefined ? {} : { maxMemories: stage.maxMemories }),
      });
    }
  }
  const actualKeys = new Set<string>();
  for (const run of input.runs) {
    const key = `${run.sequenceId}\0${run.arm}\0${run.iteration}\0${run.stageId}`;
    const label = `${run.sequenceId}/${run.arm}/${run.iteration}/${run.stageId}`;
    if (actualKeys.has(key)) failures.push(`${label}: duplicate stage run`);
    actualKeys.add(key);
    if (!expectedKeys.has(key)) failures.push(`${label}: unexpected stage run`);
    const expectedConfiguration = expectedConfigurations.get(key);
    if (expectedConfiguration
      && (run.runner !== expectedConfiguration.runner || run.model !== expectedConfiguration.model)) {
      failures.push(
        `${label}: used ${run.runner}/${run.model}, expected ${expectedConfiguration.runner}/${expectedConfiguration.model}`,
      );
    }
    if (expectedConfiguration?.maxMemories !== undefined
      && run.maxMemories !== expectedConfiguration.maxMemories) {
      failures.push(
        `${label}: used maxMemories=${run.maxMemories}, expected ${expectedConfiguration.maxMemories}`,
      );
    }
    if (run.requestedCommit !== run.baseCommit) failures.push(`${label}: checked out ${run.baseCommit}, expected ${run.requestedCommit}`);
    if (!run.initialWorktreeClean) failures.push(`${label}: stage did not begin from a clean checkout`);
    if (run.unexpectedChanges.length) failures.push(`${label}: unexpected changes ${run.unexpectedChanges.join(", ")}`);
    if (run.agent.exitCode !== 0 || run.agent.signal || run.agent.timedOut || run.agent.aborted || run.agent.error) {
      failures.push(`${label}: Agent did not exit cleanly`);
    }
    if (!Number.isInteger(run.agent.attempts) || run.agent.attempts < 1
      || !Number.isInteger(run.agent.infrastructureRetries) || run.agent.infrastructureRetries < 0
      || run.agent.infrastructureRetries !== run.agent.attempts - 1) {
      failures.push(`${label}: Agent attempt telemetry is inconsistent`);
    }
    if (run.agent.retryExhausted) failures.push(`${label}: transient infrastructure retries were exhausted`);
    if (!run.lifecycle.commitSucceeded) failures.push(`${label}: RepoMind session commit did not complete`);
    if (run.events.repoMindCalls !== 0) failures.push(`${label}: Host-managed Agent called RepoMind MCP`);
    const checks = [...run.publicChecks, ...run.hiddenChecks];
    if (run.stageIndex === 0 && !passedChecks(run.hiddenChecks)) {
      failures.push(`${label}: producer hidden checks did not all pass`);
    }
    const expectedVerification = checks.some((check) => check.exitCode !== null && check.exitCode !== 0)
      ? false
      : checks.some((check) => check.exitCode === null) ? null : true;
    if (run.quality.authoritativeVerification.authority !== "benchmark-manifest"
      || run.quality.authoritativeVerification.checks !== checks.length
      || run.quality.authoritativeVerification.passed !== expectedVerification) {
      failures.push(`${label}: authoritative verification telemetry is inconsistent`);
    }
    if (run.quality.authoritativeVerification.snapshotStable !== true) {
      failures.push(`${label}: verification changed the worktree`);
    }
    if (run.quality.maintenanceEligible !== (run.quality.status === "success")) {
      failures.push(`${label}: Host quality maintenance eligibility is inconsistent`);
    }
    const expectedStatus = run.quality.status === "success" ? "committed" : run.quality.status;
    if (run.lifecycle.status !== expectedStatus) {
      failures.push(`${label}: session status does not match Host quality assessment`);
    }
    if (run.lifecycle.status === "committed") {
      if (!run.maintenance || run.maintenance.status === "partial" || run.maintenance.status === "failed") {
        failures.push(`${label}: committed stage maintenance is missing or unsuccessful`);
      }
    } else if (run.maintenance !== null || run.lifecycle.maintenanceMs !== null) {
      failures.push(`${label}: non-committed stage unexpectedly ran derived maintenance`);
    }
    if (run.memoryState.openSessions !== 0 || run.memoryState.runningHostRuns !== 0) {
      failures.push(`${label}: lifecycle resources remain open`);
    }
    for (const layer of [run.context.l1, run.context.l2, run.context.l3]) {
      if (layer.provided !== layer.providedIds.length || layer.eligible !== layer.eligibleIds.length
        || layer.injected !== layer.injectedIds.length || layer.deduplicated !== layer.deduplicatedIds.length
        || layer.injected + layer.deduplicated > layer.eligible
        || layer.omitted !== layer.eligible - layer.injected - layer.deduplicated
        || layer.candidateChars + layer.deduplicatedChars !== layer.sourceChars) {
        failures.push(`${label}: context layer telemetry is inconsistent`);
        break;
      }
    }
    if (run.arm === "isolated" && run.stageIndex > 0 && recalled(run)) {
      failures.push(`${label}: isolated stage recalled records from a fresh database`);
    }
    if (run.arm === "shared" && run.stageIndex === 0 && recalled(run)) {
      failures.push(`${label}: first shared stage unexpectedly started with memory`);
    }
  }
  for (const key of expectedKeys) if (!actualKeys.has(key)) {
    failures.push(`${key.replaceAll("\0", "/")}: missing stage run`);
  }
  for (const sequence of input.expected) for (let iteration = 1; iteration <= input.repeat; iteration += 1) {
    const episode = input.runs.filter((run) => run.sequenceId === sequence.sequenceId && run.iteration === iteration);
    if (new Set(episode.map((run) => run.projectId)).size !== 1) {
      failures.push(`${sequence.sequenceId}/${iteration}: projectId changed across arms or stages`);
    }
    const isolatedProducer = episode.find((run) => run.arm === "isolated" && run.stageIndex === 0);
    const sharedProducer = episode.find((run) => run.arm === "shared" && run.stageIndex === 0);
    if (isolatedProducer && sharedProducer && isolatedProducer.checkpointTree !== sharedProducer.checkpointTree) {
      failures.push(`${sequence.sequenceId}/${iteration}: producer checkpoint trees differ across arms`);
    }
    for (const stage of sequence.stages) {
      const isolated = episode.find((run) => run.arm === "isolated" && run.stageId === stage.stageId);
      const shared = episode.find((run) => run.arm === "shared" && run.stageId === stage.stageId);
      if (isolated && shared && (isolated.runner !== shared.runner || isolated.model !== shared.model)) {
        failures.push(`${sequence.sequenceId}/${iteration}/${stage.stageId}: paired runner/model differ across arms`);
      }
    }
    for (const arm of ["isolated", "shared"] as const) {
      const chain = episode.filter((run) => run.arm === arm).sort((a, b) => a.stageIndex - b.stageIndex);
      for (let index = 1; index < chain.length; index += 1) {
        if (chain[index]!.previousCheckpointCommit !== chain[index - 1]!.checkpointCommit
          || chain[index]!.baseCommit !== chain[index - 1]!.checkpointCommit) {
          failures.push(`${sequence.sequenceId}/${arm}/${iteration}: stage checkpoint chain is broken at ${chain[index]!.stageId}`);
        }
      }
      const dataDirectories = new Set(chain.map((run) => run.dataDirectory));
      if (arm === "shared" && dataDirectories.size !== 1) failures.push(`${sequence.sequenceId}/shared/${iteration}: data directory was not shared`);
      if (arm === "isolated" && dataDirectories.size !== chain.length) failures.push(`${sequence.sequenceId}/isolated/${iteration}: stage databases were not isolated`);
    }
  }
  return failures;
}

function acceptance(
  criteria: CrossSessionAcceptanceCriteria | undefined,
  integrityPassed: boolean,
  transfer: CrossSessionEvalReport["transfer"],
  derivedConsumption: CrossSessionEvalReport["derivedConsumption"],
  efficiencyCoverage: CrossSessionEvalReport["efficiencyCoverage"],
  comparison: readonly CrossSessionMetric[],
): CrossSessionEvalReport["acceptance"] {
  if (!criteria) return { status: "not-configured", criteria: null, checks: [] };
  const checks: CrossSessionAcceptanceCheck[] = [{
    id: "integrity",
    passed: integrityPassed,
    measured: integrityPassed ? 1 : 0,
    target: "true",
    detail: "Experiment integrity must pass before outcome acceptance is meaningful.",
  }];
  const add = (id: string, measured: number | null, target: string, passed: boolean, detail: string): void => {
    checks.push({ id, measured: measured === null ? null : round(measured), target, passed, detail });
  };
  const hasEfficiencyGate = criteria.maxMeanDurationRegressionPercent !== undefined
    || criteria.maxMeanInputTokenRegressionPercent !== undefined
    || criteria.minInputTokenPairedWinRate !== undefined
    || criteria.maxMeanTotalPromptTokenRegressionPercent !== undefined
    || criteria.minTotalPromptTokenPairedWinRate !== undefined
    || criteria.minAgentDurationPairedWinRate !== undefined
    || criteria.minComparablePairCoverageRate !== undefined;
  if (hasEfficiencyGate) {
    const minimum = criteria.minComparablePairCoverageRate ?? DEFAULT_MIN_COMPARABLE_PAIR_COVERAGE_RATE;
    add(
      "comparablePairCoverageRate",
      efficiencyCoverage.rate,
      `>= ${minimum}`,
      efficiencyCoverage.rate >= minimum,
      "Efficiency-eligible pairs divided by all complete transfer pairs; both arms need non-empty passing public and hidden checks plus authoritative verification.",
    );
  }
  if (criteria.minSharedTransferHiddenPassRate !== undefined) add(
    "sharedTransferHiddenPassRate", transfer.sharedHiddenPassRate,
    `>= ${criteria.minSharedTransferHiddenPassRate}`,
    transfer.sharedHiddenPassRate >= criteria.minSharedTransferHiddenPassRate,
    "Shared-memory transfer stages must pass external hidden checks.",
  );
  if (criteria.minTransferHiddenPassRateDelta !== undefined) {
    const delta = transfer.sharedHiddenPassRate - transfer.isolatedHiddenPassRate;
    add("transferHiddenPassRateDelta", delta, `>= ${criteria.minTransferHiddenPassRateDelta}`,
      delta >= criteria.minTransferHiddenPassRateDelta, "Shared minus isolated hidden pass rate.");
  }
  if (criteria.minSharedRecallRate !== undefined) add(
    "sharedRecallRate", transfer.sharedRecallRate, `>= ${criteria.minSharedRecallRate}`,
    transfer.sharedRecallRate >= criteria.minSharedRecallRate,
    "Transfer stages with at least one injected L1, L2, or L3 record.",
  );
  if (criteria.maxIsolatedRecallRate !== undefined) add(
    "isolatedRecallRate", transfer.isolatedRecallRate, `<= ${criteria.maxIsolatedRecallRate}`,
    transfer.isolatedRecallRate <= criteria.maxIsolatedRecallRate,
    "Fresh per-stage databases must not contain prior-session records.",
  );
  if (criteria.minSharedCommitRate !== undefined) add(
    "sharedCommitRate", transfer.sharedCommitRate, `>= ${criteria.minSharedCommitRate}`,
    transfer.sharedCommitRate >= criteria.minSharedCommitRate,
    "Shared transfer stages whose Host commit completed and closed the Session, independent of task outcome.",
  );
  if (criteria.minSharedDerivedRecallRate !== undefined) add(
    "sharedDerivedRecallRate", derivedConsumption.sharedDerivedRecallRate,
    `>= ${criteria.minSharedDerivedRecallRate}`,
    derivedConsumption.sharedDerivedRecallRate >= criteria.minSharedDerivedRecallRate,
    "Shared stages configured with maxMemories=0 that injected at least one L2 or L3 record.",
  );
  if (criteria.minSharedL2RecallRate !== undefined) add(
    "sharedL2RecallRate", derivedConsumption.sharedL2RecallRate,
    `>= ${criteria.minSharedL2RecallRate}`,
    derivedConsumption.sharedL2RecallRate >= criteria.minSharedL2RecallRate,
    "Shared stages configured with maxMemories=0 that injected at least one L2 module narrative.",
  );
  if (criteria.minSharedL3RecallRate !== undefined) add(
    "sharedL3RecallRate", derivedConsumption.sharedL3RecallRate,
    `>= ${criteria.minSharedL3RecallRate}`,
    derivedConsumption.sharedL3RecallRate >= criteria.minSharedL3RecallRate,
    "Shared stages configured with maxMemories=0 that injected the current L3 repository profile.",
  );
  if (criteria.maxSharedDerivedStageL1RecallRate !== undefined) add(
    "sharedDerivedStageL1RecallRate", derivedConsumption.sharedL1RecallRate,
    `<= ${criteria.maxSharedDerivedStageL1RecallRate}`,
    derivedConsumption.sharedL1RecallRate <= criteria.maxSharedDerivedStageL1RecallRate,
    "L1 injection rate in shared stages configured with maxMemories=0; this must be zero for a derived-only test.",
  );
  if (criteria.maxIsolatedDerivedRecallRate !== undefined) add(
    "isolatedDerivedRecallRate", derivedConsumption.isolatedDerivedRecallRate,
    `<= ${criteria.maxIsolatedDerivedRecallRate}`,
    derivedConsumption.isolatedDerivedRecallRate <= criteria.maxIsolatedDerivedRecallRate,
    "Fresh isolated stages configured with maxMemories=0 must not inject L2 or L3 records.",
  );
  if (criteria.maxMeanDurationRegressionPercent !== undefined) {
    const duration = comparison.find((metric) => metric.key === "hostLifecycleMs");
    const measured = duration?.relativeDeltaPercent ?? null;
    add("meanDurationRegressionPercent", measured, `<= ${criteria.maxMeanDurationRegressionPercent}`,
      measured !== null && measured <= criteria.maxMeanDurationRegressionPercent,
      "Shared relative to isolated Host lifecycle duration among efficiency-eligible pairs; unavailable when the isolated mean is zero.");
  }
  if (criteria.maxMeanInputTokenRegressionPercent !== undefined) {
    const inputTokens = comparison.find((metric) => metric.key === "inputTokens");
    const measured = inputTokens?.relativeDeltaPercent ?? null;
    add("meanInputTokenRegressionPercent", measured, `<= ${criteria.maxMeanInputTokenRegressionPercent}`,
      measured !== null && measured <= criteria.maxMeanInputTokenRegressionPercent,
      "Shared relative to isolated mean Agent input tokens among efficiency-eligible pairs; unavailable when the isolated mean is zero.");
  }
  if (criteria.minInputTokenPairedWinRate !== undefined) {
    const inputTokens = comparison.find((metric) => metric.key === "inputTokens");
    const measured = inputTokens?.pairs ? inputTokens.sharedWins / inputTokens.pairs : null;
    add("inputTokenPairedWinRate", measured, `>= ${criteria.minInputTokenPairedWinRate}`,
      measured !== null && measured >= criteria.minInputTokenPairedWinRate,
      "Fraction of efficiency-eligible pairs where shared memory used fewer Agent input tokens.");
  }
  if (criteria.maxMeanTotalPromptTokenRegressionPercent !== undefined) {
    const totalPromptTokens = comparison.find((metric) => metric.key === "totalPromptTokens");
    const measured = totalPromptTokens?.relativeDeltaPercent ?? null;
    add(
      "meanTotalPromptTokenRegressionPercent",
      measured,
      `<= ${criteria.maxMeanTotalPromptTokenRegressionPercent}`,
      measured !== null && measured <= criteria.maxMeanTotalPromptTokenRegressionPercent,
      "Shared relative to isolated mean total prompt tokens (uncached input plus cache read and cache write) among efficiency-eligible pairs; unavailable when the isolated mean is zero.",
    );
  }
  if (criteria.minTotalPromptTokenPairedWinRate !== undefined) {
    const totalPromptTokens = comparison.find((metric) => metric.key === "totalPromptTokens");
    const measured = totalPromptTokens?.pairs ? totalPromptTokens.sharedWins / totalPromptTokens.pairs : null;
    add(
      "totalPromptTokenPairedWinRate",
      measured,
      `>= ${criteria.minTotalPromptTokenPairedWinRate}`,
      measured !== null && measured >= criteria.minTotalPromptTokenPairedWinRate,
      "Fraction of efficiency-eligible pairs where shared memory used fewer total prompt tokens, including cache reads and cache writes.",
    );
  }
  if (criteria.minAgentDurationPairedWinRate !== undefined) {
    const duration = comparison.find((metric) => metric.key === "agentDurationMs");
    const measured = duration?.pairs ? duration.sharedWins / duration.pairs : null;
    add("agentDurationPairedWinRate", measured, `>= ${criteria.minAgentDurationPairedWinRate}`,
      measured !== null && measured >= criteria.minAgentDurationPairedWinRate,
      "Fraction of efficiency-eligible pairs where the shared Agent duration was lower.");
  }
  return { status: checks.every((check) => check.passed) ? "passed" : "failed", criteria, checks };
}

export function buildCrossSessionReport(input: BuildCrossSessionReportInput): CrossSessionEvalReport {
  const transferRuns = input.runs.filter((run) => run.stageIndex > 0);
  const shared = transferRuns.filter((run) => run.arm === "shared");
  const isolated = transferRuns.filter((run) => run.arm === "isolated");
  const rate = (runs: readonly CrossSessionStageRun[], predicate: (run: CrossSessionStageRun) => boolean): number =>
    round(runs.length ? runs.filter(predicate).length / runs.length : 0);
  const transfer = {
    runsPerArm: shared.length,
    sharedRecallRate: rate(shared, recalled),
    isolatedRecallRate: rate(isolated, recalled),
    sharedHiddenPassRate: rate(shared, (run) => passedChecks(run.hiddenChecks)),
    isolatedHiddenPassRate: rate(isolated, (run) => passedChecks(run.hiddenChecks)),
    sharedCommitRate: rate(shared, (run) => run.lifecycle.commitSucceeded),
    isolatedCommitRate: rate(isolated, (run) => run.lifecycle.commitSucceeded),
  };
  const derivedOnlyRuns = transferRuns.filter((run) => run.maxMemories === 0);
  const derivedShared = derivedOnlyRuns.filter((run) => run.arm === "shared");
  const derivedIsolated = derivedOnlyRuns.filter((run) => run.arm === "isolated");
  const derivedRate = (
    runs: readonly CrossSessionStageRun[],
    predicate: (run: CrossSessionStageRun) => boolean,
  ): number => round(runs.length ? runs.filter(predicate).length / runs.length : 0);
  const derivedConsumption = {
    runsPerArm: derivedShared.length,
    sharedDerivedRecallRate: derivedRate(
      derivedShared,
      (run) => run.context.l2.injected + run.context.l3.injected > 0,
    ),
    isolatedDerivedRecallRate: derivedRate(
      derivedIsolated,
      (run) => run.context.l2.injected + run.context.l3.injected > 0,
    ),
    sharedL1RecallRate: derivedRate(derivedShared, (run) => run.context.l1.injected > 0),
    isolatedL1RecallRate: derivedRate(derivedIsolated, (run) => run.context.l1.injected > 0),
    sharedL2RecallRate: derivedRate(derivedShared, (run) => run.context.l2.injected > 0),
    sharedL3RecallRate: derivedRate(derivedShared, (run) => run.context.l3.injected > 0),
  };
  const pairs = pairedRuns(input.runs);
  const eligibleEfficiencyPairs = pairs.filter((pair) =>
    passedAllChecks(pair.isolated) && passedAllChecks(pair.shared));
  const efficiencyCoverage = {
    totalPairs: pairs.length,
    eligiblePairs: eligibleEfficiencyPairs.length,
    excludedPairs: pairs.length - eligibleEfficiencyPairs.length,
    rate: round(pairs.length ? eligibleEfficiencyPairs.length / pairs.length : 0),
  };
  const comparison = METRICS.map((definition) => summarizeMetric(
    EFFICIENCY_METRIC_KEYS.has(definition.key) ? eligibleEfficiencyPairs : pairs,
    definition,
  ));
  const failures = integrityFailures(input);
  const integrity = { passed: failures.length === 0, failures };
  const runners = new Set(input.runs.map((run) => run.runner));
  const models = new Set(input.runs.map((run) => run.model));
  const infrastructure = {
    stageRuns: input.runs.length,
    processAttempts: input.runs.reduce((sum, run) => sum + run.agent.attempts, 0),
    retries: input.runs.reduce((sum, run) => sum + run.agent.infrastructureRetries, 0),
    retriedStageRuns: input.runs.filter((run) => run.agent.infrastructureRetries > 0).length,
    exhaustedStageRuns: input.runs.filter((run) => run.agent.retryExhausted).length,
  };
  return {
    version: 4,
    generatedAt: new Date().toISOString(),
    name: input.name,
    runner: runners.size === 1 ? [...runners][0]! : "mixed",
    model: models.size === 1 ? [...models][0]! : "mixed",
    repeat: input.repeat,
    outputDirectory: input.outputDirectory,
    provenance: input.provenance,
    runs: input.runs,
    transfer,
    derivedConsumption,
    efficiencyCoverage,
    infrastructure,
    comparison,
    integrity,
    acceptance: acceptance(
      input.acceptanceCriteria,
      integrity.passed,
      transfer,
      derivedConsumption,
      efficiencyCoverage,
      comparison,
    ),
  };
}

function format(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function renderCrossSessionMarkdown(report: CrossSessionEvalReport): string {
  const metrics = report.comparison.map((metric) =>
    `| ${metric.key} | ${metric.pairs} | ${format(metric.isolatedMean)} | ${format(metric.sharedMean)} | ${format(metric.meanDelta)} | ${metric.relativeDeltaPercent === null ? "n/a" : `${format(metric.relativeDeltaPercent)}%`} | ${metric.sharedWins}/${metric.ties}/${metric.sharedLosses} |`,
  ).join("\n")
    + `\n\nReport schema: v${report.version}. Efficiency eligibility also requires non-empty public and hidden checks plus successful authoritative verification. When any efficiency acceptance criterion is configured, minComparablePairCoverageRate defaults to ${DEFAULT_MIN_COMPARABLE_PAIR_COVERAGE_RATE}.`;
  const acceptanceRows = report.acceptance.checks.map((check) =>
    `| ${check.id} | ${check.passed ? "yes" : "NO"} | ${format(check.measured)} | ${check.target} | ${check.detail} |`,
  ).join("\n");
  return `# RepoMind cross-session learning benchmark\n\nManifest: ${report.name}\n\nRunner: ${report.runner} / ${report.model}\n\nRepeat: ${report.repeat}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nAcceptance: **${report.acceptance.status}**\n\n## Transfer summary\n\n| Measure | Isolated | Shared |\n| --- | ---: | ---: |\n| Recall rate | ${format(report.transfer.isolatedRecallRate)} | ${format(report.transfer.sharedRecallRate)} |\n| Hidden pass rate | ${format(report.transfer.isolatedHiddenPassRate)} | ${format(report.transfer.sharedHiddenPassRate)} |\n| Commit rate | ${format(report.transfer.isolatedCommitRate)} | ${format(report.transfer.sharedCommitRate)} |\n\n## Derived-only consumption\n\nThis section includes transfer stages whose effective maxMemories is zero. L1 must remain absent; L2/L3 are independently reported.\n\n| Runs per arm | Shared derived | Isolated derived | Shared L1 | Isolated L1 | Shared L2 | Shared L3 |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n| ${report.derivedConsumption.runsPerArm} | ${format(report.derivedConsumption.sharedDerivedRecallRate)} | ${format(report.derivedConsumption.isolatedDerivedRecallRate)} | ${format(report.derivedConsumption.sharedL1RecallRate)} | ${format(report.derivedConsumption.isolatedL1RecallRate)} | ${format(report.derivedConsumption.sharedL2RecallRate)} | ${format(report.derivedConsumption.sharedL3RecallRate)} |\n\n## Infrastructure attempts\n\n| Stage runs | Process attempts | Retries | Retried stages | Exhausted stages |\n| ---: | ---: | ---: | ---: | ---: |\n| ${report.infrastructure.stageRuns} | ${report.infrastructure.processAttempts} | ${report.infrastructure.retries} | ${report.infrastructure.retriedStageRuns} | ${report.infrastructure.exhaustedStageRuns} |\n\nFresh retries require an explicit transient infrastructure signal, zero input/output tokens, zero Agent activity, and an unchanged Git snapshot. An upstream HTTP/2 stream failure may instead resume the same provider session after only resume-safe local tool activity and no shell, command, or RepoMind activity. Retry delay and every process attempt remain included in Host duration, but retries are not counted as additional experimental stages.\n\n## Paired transfer comparison\n\nEfficiency metrics use only eligible pairs where both arms passed every public and hidden check. Correctness, diagnostic, and context metrics use all complete pairs.\n\n| Total pairs | Eligible efficiency pairs | Excluded pairs | Comparable coverage |\n| ---: | ---: | ---: | ---: |\n| ${report.efficiencyCoverage.totalPairs} | ${report.efficiencyCoverage.eligiblePairs} | ${report.efficiencyCoverage.excludedPairs} | ${format(report.efficiencyCoverage.rate)} |\n\n| Metric | Pairs | Isolated mean | Shared mean | Mean delta | Delta | Shared win/tie/loss |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${metrics}\n\n## Acceptance checks\n\n${acceptanceRows ? `| Check | Passed | Measured | Target | Detail |\n| --- | --- | ---: | --- | --- |\n${acceptanceRows}` : "No acceptance criteria configured."}\n\n## Runs\n\nL1/L2/L3 is the number of records actually injected into the Host prompt. Token cells are uncached input/cache-read/cache-write tokens; file-read cells are successful/failed reads.\n\n| Sequence | Repeat | Arm | Stage | Runner | Model | Max L1 | Hidden | Session | Attempts | L1/L2/L3 | Host ms | Input/cache-read/cache-write tokens | Successful/failed file reads |\n| --- | ---: | --- | --- | --- | --- | ---: | --- | --- | ---: | --- | ---: | ---: | ---: |\n${report.runs.map((run) => {
    const hidden = `${run.hiddenChecks.filter((check) => check.passed).length}/${run.hiddenChecks.length}`;
    const injected = `${run.context.l1.injected}/${run.context.l2.injected}/${run.context.l3.injected}`;
    const tokens = `${run.events.tokens.input}/${run.events.tokens.cacheRead}/${run.events.tokens.cacheWrite}`;
    const reads = `${run.events.fileReads}/${run.events.failedFileReads}`;
    return `| ${run.sequenceId} | ${run.iteration} | ${run.arm} | ${run.stageIndex + 1}:${run.stageId} | ${run.runner} | ${run.model} | ${run.maxMemories} | ${hidden} | ${run.lifecycle.status} | ${run.agent.attempts} | ${injected} | ${format(run.lifecycle.hostLifecycleMs)} | ${tokens} | ${reads} |`;
  }).join("\n")}\n\n## Integrity failures\n\n${report.integrity.failures.length ? report.integrity.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}
