import type { AgentAcceptanceCriteria } from "./manifest.js";
import type { AgentEventMetrics } from "./events.js";

export type AgentArm = "no-memory" | "repomind";
export type PairedMetricKey = "hiddenSuccess" | "publicSuccess" | "wallDurationMs" | "inputTokens" | "outputTokens" | "fileReads";

export interface CheckResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
}

export interface AgentRunResult {
  taskId: string;
  arm: AgentArm;
  iteration: number;
  repository: string;
  requestedCommit: string;
  baseCommit: string;
  agentExitCode: number | null;
  agentSignal: string | null;
  wallDurationMs: number;
  publicChecks: CheckResult[];
  hiddenChecks: CheckResult[];
  changedFiles: string[];
  unexpectedChanges: string[];
  sessionsBeforeCleanup: Array<{ id: string; status: string }>;
  abandonedSessions: number;
  openSessionsAfterCleanup: number;
  events: AgentEventMetrics;
}

export interface PairedMetric {
  key: PairedMetricKey;
  preferred: "higher" | "lower";
  pairs: number;
  noMemoryMean: number;
  repoMindMean: number;
  meanDelta: number;
  medianDelta: number;
  relativeDeltaPercent: number | null;
  repoMindWins: number;
  ties: number;
  repoMindLosses: number;
}

export interface PairedTaskResult {
  taskId: string;
  pairs: number;
  metrics: PairedMetric[];
}

export interface AcceptanceCheck {
  id: string;
  passed: boolean;
  measured: number | boolean;
  target: string;
  detail: string;
}

export interface AgentEvalReport {
  version: 3;
  name: string;
  generatedAt: string;
  runner: "opencode";
  model: string;
  repeat: number;
  outputDirectory: string;
  provenance: AgentProvenance;
  runs: AgentRunResult[];
  arms: Record<AgentArm, {
    runs: number;
    agentCleanExits: number;
    publicPasses: number;
    hiddenPasses: number;
    meanWallDurationMs: number;
    meanInputTokens: number;
    meanOutputTokens: number;
    meanFileReads: number;
    repoMindCalls: number;
    retrievedMemories: number;
  }>;
  paired: { pairs: number; overall: PairedMetric[]; tasks: PairedTaskResult[] };
  integrity: { passed: boolean; failures: string[] };
  acceptance: {
    status: "passed" | "failed" | "not-configured";
    criteria: AgentAcceptanceCriteria | null;
    checks: AcceptanceCheck[];
  };
}

export interface AgentProvenance {
  repoMindVersion: string;
  repoMindCommit: string | null;
  repoMindDirty: boolean | null;
  node: string;
  os: { platform: NodeJS.Platform; release: string; arch: string };
  runnerVersion: string | null;
  manifestSha256: string;
  taskBaseCommits: Record<string, string>;
}

export interface BuildAgentReportInput {
  name: string;
  runner: "opencode";
  model: string;
  repeat: number;
  outputDirectory: string;
  provenance: AgentProvenance;
  runs: AgentRunResult[];
  acceptanceCriteria?: AgentAcceptanceCriteria;
}

interface AgentPair { taskId: string; iteration: number; noMemory: AgentRunResult; repoMind: AgentRunResult }

const METRICS: Array<{ key: PairedMetricKey; preferred: "higher" | "lower" }> = [
  { key: "hiddenSuccess", preferred: "higher" },
  { key: "publicSuccess", preferred: "higher" },
  { key: "wallDurationMs", preferred: "lower" },
  { key: "inputTokens", preferred: "lower" },
  { key: "outputTokens", preferred: "lower" },
  { key: "fileReads", preferred: "lower" },
];

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function passed(checks: CheckResult[]): number {
  return checks.every((check) => check.passed) ? 1 : 0;
}

function metricValue(run: AgentRunResult, key: PairedMetricKey): number {
  switch (key) {
    case "hiddenSuccess": return passed(run.hiddenChecks);
    case "publicSuccess": return passed(run.publicChecks);
    case "wallDurationMs": return run.wallDurationMs;
    case "inputTokens": return run.events.tokens.input;
    case "outputTokens": return run.events.tokens.output;
    case "fileReads": return run.events.fileReads;
  }
}

function collectPairs(runs: AgentRunResult[]): { pairs: AgentPair[]; failures: string[] } {
  const grouped = new Map<string, AgentRunResult[]>();
  for (const run of runs) {
    const key = `${run.taskId}\0${run.iteration}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  const pairs: AgentPair[] = [];
  const failures: string[] = [];
  for (const group of grouped.values()) {
    const noMemory = group.filter((run) => run.arm === "no-memory");
    const repoMind = group.filter((run) => run.arm === "repomind");
    const first = group[0]!;
    if (noMemory.length !== 1 || repoMind.length !== 1) {
      failures.push(`${first.taskId}/iteration-${first.iteration}: expected exactly one run per arm`);
      continue;
    }
    pairs.push({ taskId: first.taskId, iteration: first.iteration, noMemory: noMemory[0]!, repoMind: repoMind[0]! });
  }
  pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.iteration - b.iteration);
  return { pairs, failures };
}

function summarizeMetric(pairs: AgentPair[], definition: typeof METRICS[number]): PairedMetric {
  const noMemory = pairs.map((pair) => metricValue(pair.noMemory, definition.key));
  const repoMind = pairs.map((pair) => metricValue(pair.repoMind, definition.key));
  const deltas = repoMind.map((value, index) => value - noMemory[index]!);
  const noMemoryMean = mean(noMemory);
  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (const delta of deltas) {
    if (delta === 0) ties += 1;
    else if ((definition.preferred === "higher" && delta > 0) || (definition.preferred === "lower" && delta < 0)) wins += 1;
    else losses += 1;
  }
  return {
    ...definition,
    pairs: pairs.length,
    noMemoryMean: round(noMemoryMean),
    repoMindMean: round(mean(repoMind)),
    meanDelta: round(mean(deltas)),
    medianDelta: round(median(deltas)),
    relativeDeltaPercent: noMemoryMean === 0 ? null : round((mean(deltas) / Math.abs(noMemoryMean)) * 100),
    repoMindWins: wins,
    ties,
    repoMindLosses: losses,
  };
}

function pairedResults(pairs: AgentPair[]): AgentEvalReport["paired"] {
  const taskIds = [...new Set(pairs.map((pair) => pair.taskId))];
  return {
    pairs: pairs.length,
    overall: METRICS.map((definition) => summarizeMetric(pairs, definition)),
    tasks: taskIds.map((taskId) => {
      const selected = pairs.filter((pair) => pair.taskId === taskId);
      return { taskId, pairs: selected.length, metrics: METRICS.map((definition) => summarizeMetric(selected, definition)) };
    }),
  };
}

function metric(metrics: PairedMetric[], key: PairedMetricKey): PairedMetric {
  return metrics.find((entry) => entry.key === key)!;
}

function evaluateAcceptance(
  criteria: AgentAcceptanceCriteria | undefined,
  integrityPassed: boolean,
  paired: AgentEvalReport["paired"],
  runs: AgentRunResult[],
): AgentEvalReport["acceptance"] {
  if (!criteria) return { status: "not-configured", criteria: null, checks: [] };
  const checks: AcceptanceCheck[] = [{
    id: "integrity", passed: integrityPassed, measured: integrityPassed, target: "true",
    detail: "Experiment integrity must pass before outcome acceptance is meaningful.",
  }];
  const hidden = metric(paired.overall, "hiddenSuccess");
  const duration = metric(paired.overall, "wallDurationMs");
  const inputTokens = metric(paired.overall, "inputTokens");
  const fileReads = metric(paired.overall, "fileReads");
  const repoMindRuns = runs.filter((run) => run.arm === "repomind");
  const retrievalRate = repoMindRuns.length ? repoMindRuns.filter((run) => run.events.retrievedMemories > 0).length / repoMindRuns.length : 0;
  const sessionCommitRate = repoMindRuns.length
    ? repoMindRuns.filter((run) => run.sessionsBeforeCleanup.some((session) => session.status === "committed")).length / repoMindRuns.length
    : 0;
  if (criteria.minRepoMindHiddenPassRate !== undefined) checks.push({
    id: "repoMindHiddenPassRate", passed: hidden.repoMindMean >= criteria.minRepoMindHiddenPassRate,
    measured: hidden.repoMindMean, target: `>= ${criteria.minRepoMindHiddenPassRate}`, detail: "RepoMind hidden-check pass rate.",
  });
  if (criteria.minHiddenPassRateDelta !== undefined) checks.push({
    id: "hiddenPassRateDelta", passed: hidden.meanDelta >= criteria.minHiddenPassRateDelta,
    measured: hidden.meanDelta, target: `>= ${criteria.minHiddenPassRateDelta}`, detail: "RepoMind minus no-memory hidden-check pass rate.",
  });
  if (criteria.minRetrievalRate !== undefined) checks.push({
    id: "retrievalRate", passed: retrievalRate >= criteria.minRetrievalRate,
    measured: round(retrievalRate), target: `>= ${criteria.minRetrievalRate}`, detail: "Share of RepoMind runs retrieving at least one memory.",
  });
  if (criteria.minSessionCommitRate !== undefined) checks.push({
    id: "sessionCommitRate", passed: sessionCommitRate >= criteria.minSessionCommitRate,
    measured: round(sessionCommitRate), target: `>= ${criteria.minSessionCommitRate}`, detail: "Share of RepoMind runs with a committed session.",
  });
  if (criteria.maxMeanDurationRegressionPercent !== undefined) {
    const regression = duration.relativeDeltaPercent ?? 0;
    checks.push({
      id: "durationRegression", passed: regression <= criteria.maxMeanDurationRegressionPercent,
      measured: regression, target: `<= ${criteria.maxMeanDurationRegressionPercent}%`, detail: "Mean wall-time regression; negative values are improvements.",
    });
  }
  if (criteria.requireEfficiencyImprovement !== undefined) {
    const improved = inputTokens.meanDelta < 0 || fileReads.meanDelta < 0;
    checks.push({
      id: "efficiencyImprovement", passed: criteria.requireEfficiencyImprovement ? improved : true,
      measured: improved, target: criteria.requireEfficiencyImprovement ? "true" : "not required",
      detail: "At least one of mean input tokens or file reads improved.",
    });
  }
  for (const taskId of criteria.requiredTaskWins ?? []) {
    const task = paired.tasks.find((entry) => entry.taskId === taskId);
    const taskHidden = task ? metric(task.metrics, "hiddenSuccess") : null;
    checks.push({
      id: `requiredTaskWin:${taskId}`, passed: taskHidden !== null && taskHidden.meanDelta > 0,
      measured: taskHidden?.meanDelta ?? false, target: "> 0", detail: taskHidden
        ? "Required positive hidden-check pass-rate delta."
        : "No complete A/B pair was available for the required task.",
    });
  }
  return { status: checks.every((check) => check.passed) ? "passed" : "failed", criteria, checks };
}

export function buildAgentReport(input: BuildAgentReportInput): AgentEvalReport {
  const arms = Object.fromEntries((["no-memory", "repomind"] as const).map((arm) => {
    const runs = input.runs.filter((run) => run.arm === arm);
    return [arm, {
      runs: runs.length,
      agentCleanExits: runs.filter((run) => run.agentExitCode === 0).length,
      publicPasses: runs.filter((run) => passed(run.publicChecks)).length,
      hiddenPasses: runs.filter((run) => passed(run.hiddenChecks)).length,
      meanWallDurationMs: round(mean(runs.map((run) => run.wallDurationMs))),
      meanInputTokens: round(mean(runs.map((run) => run.events.tokens.input))),
      meanOutputTokens: round(mean(runs.map((run) => run.events.tokens.output))),
      meanFileReads: round(mean(runs.map((run) => run.events.fileReads))),
      repoMindCalls: runs.reduce((sum, run) => sum + run.events.repoMindCalls, 0),
      retrievedMemories: runs.reduce((sum, run) => sum + run.events.retrievedMemories, 0),
    }];
  })) as AgentEvalReport["arms"];

  const pairCollection = collectPairs(input.runs);
  const failures = [...pairCollection.failures];
  for (const run of input.runs) {
    const label = `${run.taskId}/${run.arm}-${run.iteration}`;
    if (run.agentExitCode !== 0) failures.push(`${label}: agent exited with ${run.agentExitCode ?? run.agentSignal ?? "unknown"}`);
    if (run.baseCommit !== run.requestedCommit) failures.push(`${label}: clone is not at the resolved base commit`);
    if (run.unexpectedChanges.length) failures.push(`${label}: unexpected changes: ${run.unexpectedChanges.join(", ")}`);
    if ([...run.publicChecks, ...run.hiddenChecks].some((check) => check.exitCode === null)) failures.push(`${label}: a check could not be executed`);
    if (run.openSessionsAfterCleanup) failures.push(`${label}: open RepoMind sessions remain after cleanup`);
    if (run.arm === "repomind" && run.events.repoMindCalls === 0) failures.push(`${label}: RepoMind MCP was not called`);
    if (run.arm === "no-memory" && run.events.repoMindCalls !== 0) failures.push(`${label}: no-memory arm called RepoMind MCP`);
  }
  const paired = pairedResults(pairCollection.pairs);
  const integrity = { passed: failures.length === 0, failures };
  return {
    version: 3, generatedAt: new Date().toISOString(), name: input.name, runner: input.runner,
    model: input.model, repeat: input.repeat, outputDirectory: input.outputDirectory, provenance: input.provenance, runs: input.runs,
    arms, paired, integrity,
    acceptance: evaluateAcceptance(input.acceptanceCriteria, integrity.passed, paired, input.runs),
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${formatMetric(value)}%`;
}

export function renderAgentMarkdown(report: AgentEvalReport): string {
  const armRows = (["no-memory", "repomind"] as const).map((arm) => {
    const value = report.arms[arm];
    return `| ${arm} | ${value.hiddenPasses}/${value.runs} | ${value.publicPasses}/${value.runs} | ${(value.meanWallDurationMs / 1000).toFixed(1)} s | ${Math.round(value.meanInputTokens)} | ${Math.round(value.meanOutputTokens)} | ${value.meanFileReads.toFixed(1)} |`;
  }).join("\n");
  const pairedRows = report.paired.overall.map((entry) =>
    `| ${entry.key} | ${entry.preferred} | ${formatMetric(entry.noMemoryMean)} | ${formatMetric(entry.repoMindMean)} | ${formatMetric(entry.meanDelta)} | ${formatPercent(entry.relativeDeltaPercent)} | ${entry.repoMindWins}/${entry.ties}/${entry.repoMindLosses} |`,
  ).join("\n");
  const taskRows = report.paired.tasks.map((task) => {
    const hidden = metric(task.metrics, "hiddenSuccess");
    const duration = metric(task.metrics, "wallDurationMs");
    const tokens = metric(task.metrics, "inputTokens");
    const reads = metric(task.metrics, "fileReads");
    return `| ${task.taskId} | ${task.pairs} | ${formatMetric(hidden.noMemoryMean)} | ${formatMetric(hidden.repoMindMean)} | ${formatPercent(duration.relativeDeltaPercent)} | ${formatPercent(tokens.relativeDeltaPercent)} | ${formatPercent(reads.relativeDeltaPercent)} |`;
  }).join("\n");
  const runs = report.runs.map((run) =>
    `| ${run.taskId} | ${run.arm}-${run.iteration} | ${passed(run.hiddenChecks) ? "pass" : "fail"} | ${passed(run.publicChecks) ? "pass" : "fail"} | ${(run.wallDurationMs / 1000).toFixed(1)} s | ${run.events.tokens.input} | ${run.events.fileReads} | ${run.events.repoMindCalls} |`,
  ).join("\n");
  const acceptanceRows = report.acceptance.checks.map((check) =>
    `| ${check.id} | ${check.passed ? "yes" : "NO"} | ${String(check.measured)} | ${check.target} | ${check.detail} |`,
  ).join("\n");
  const dirty = report.provenance.repoMindDirty === null ? "unavailable" : String(report.provenance.repoMindDirty);
  const provenanceRows = `| RepoMind worktree dirty | ${dirty} |\n` + Object.entries(report.provenance.taskBaseCommits)
    .map(([task, commit]) => `| task:${task} | \`${commit}\` |`).join("\n") + "\n\n## Results";
  return `# RepoMind agent A/B benchmark\n\nManifest: ${report.name}\n\nRunner: ${report.runner} / ${report.model}\n\nRepeat: ${report.repeat}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nAcceptance: **${report.acceptance.status}**\n\n## Provenance\n\n| Field | Value |\n| --- | --- |\n| RepoMind | ${report.provenance.repoMindVersion} / \`${report.provenance.repoMindCommit ?? "not-a-git-checkout"}\` |\n| Node | ${report.provenance.node} |\n| OS | ${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch} |\n| Runner version | ${report.provenance.runnerVersion ?? "unavailable"} |\n| Manifest SHA-256 | \`${report.provenance.manifestSha256}\` |\n${provenanceRows}\n\n| Arm | Hidden checks | Public checks | Mean wall time | Mean input tokens | Mean output tokens | Mean file reads |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows}\n\n## Paired deltas\n\nDeltas are RepoMind minus no-memory. Win/tie/loss uses the preferred direction.\n\n| Metric | Preferred | No-memory mean | RepoMind mean | Mean delta | Delta % | Win/tie/loss |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${pairedRows}\n\n## Per-task paired results\n\n| Task | Pairs | Hidden no-memory | Hidden RepoMind | Duration delta | Input-token delta | File-read delta |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${taskRows}\n\n## Acceptance checks\n\n${acceptanceRows ? `| Check | Passed | Measured | Target | Detail |\n| --- | --- | ---: | --- | --- |\n${acceptanceRows}` : "No acceptance criteria configured."}\n\n## Runs\n\n| Task | Run | Hidden | Public | Wall time | Input tokens | File reads | RepoMind calls |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: |\n${runs}\n\n## Integrity failures\n\n${report.integrity.failures.length ? report.integrity.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}
