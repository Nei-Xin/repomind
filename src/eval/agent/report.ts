import type { AgentAcceptanceCriteria } from "./manifest.js";
import type { AgentEventMetrics } from "./events.js";

export type AgentArm = "no-memory" | "full-history" | "repomind";
export type AgentBaselineArm = Exclude<AgentArm, "repomind">;
export type RepoMindLifecycleMode = "agent-managed" | "host-managed";
export type AgentLifecycleMode = "none" | RepoMindLifecycleMode;
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
  startMs: number | null;
  agentMs: number;
  commitMs: number | null;
  totalLifecycleMs: number;
  wallDurationMs: number;
  publicChecks: CheckResult[];
  hiddenChecks: CheckResult[];
  changedFiles: string[];
  unexpectedChanges: string[];
  sessionsBeforeCleanup: Array<{ id: string; status: string }>;
  abandonedSessions: number;
  openSessionsAfterCleanup: number;
  lifecycle: {
    mode: AgentLifecycleMode;
    timing: "not-applicable" | "nested-in-agent" | "sequential";
    startAttempted: boolean;
    startSucceeded: boolean;
    sessionId: string | null;
    retrievedMemories: number;
    commitAttempted: boolean;
    commitSucceeded: boolean;
    commitStatus: string | null;
    evidenceCreated: number;
    error: string | null;
  };
  events: AgentEventMetrics;
}

export interface PairedMetric {
  key: PairedMetricKey;
  preferred: "higher" | "lower";
  pairs: number;
  baselineMean: number;
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

export interface PairedComparison {
  baselineArm: AgentBaselineArm;
  pairs: number;
  overall: PairedMetric[];
  tasks: PairedTaskResult[];
}

export interface AcceptanceCheck {
  id: string;
  passed: boolean;
  measured: number | boolean;
  target: string;
  detail: string;
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

interface ArmSummary {
  runs: number;
  agentCleanExits: number;
  publicPasses: number;
  hiddenPasses: number;
  meanWallDurationMs: number;
  meanStartMs: number | null;
  meanAgentMs: number;
  meanCommitMs: number | null;
  meanTotalLifecycleMs: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanFileReads: number;
  repoMindCalls: number;
  retrievedMemories: number;
}

export interface AgentEvalReport {
  version: 5;
  name: string;
  generatedAt: string;
  runner: "opencode";
  model: string;
  repeat: number;
  repoMindLifecycle: RepoMindLifecycleMode;
  outputDirectory: string;
  provenance: AgentProvenance;
  runs: AgentRunResult[];
  arms: Partial<Record<AgentArm, ArmSummary>>;
  comparisons: Record<AgentBaselineArm, PairedComparison | null>;
  integrity: { passed: boolean; failures: string[] };
  acceptance: {
    status: "passed" | "failed" | "not-configured";
    criteria: AgentAcceptanceCriteria | null;
    checks: AcceptanceCheck[];
  };
}

export interface BuildAgentReportInput {
  name: string;
  runner: "opencode";
  model: string;
  repeat: number;
  repoMindLifecycle?: RepoMindLifecycleMode;
  outputDirectory: string;
  provenance: AgentProvenance;
  runs: AgentRunResult[];
  acceptanceCriteria?: AgentAcceptanceCriteria;
}

interface AgentPair {
  taskId: string;
  iteration: number;
  baseline: AgentRunResult;
  repoMind: AgentRunResult;
}

const METRICS: Array<{ key: PairedMetricKey; preferred: "higher" | "lower" }> = [
  { key: "hiddenSuccess", preferred: "higher" },
  { key: "publicSuccess", preferred: "higher" },
  { key: "wallDurationMs", preferred: "lower" },
  { key: "inputTokens", preferred: "lower" },
  { key: "outputTokens", preferred: "lower" },
  { key: "fileReads", preferred: "lower" },
];

const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const passed = (checks: CheckResult[]): number => checks.every((check) => check.passed) ? 1 : 0;

function metricValue(run: AgentRunResult, key: PairedMetricKey): number {
  switch (key) {
    case "hiddenSuccess": return passed(run.hiddenChecks);
    case "publicSuccess": return passed(run.publicChecks);
    case "wallDurationMs": return run.totalLifecycleMs;
    case "inputTokens": return run.events.tokens.input;
    case "outputTokens": return run.events.tokens.output;
    case "fileReads": return run.events.fileReads;
  }
}

function retrievedMemories(run: AgentRunResult): number {
  return run.lifecycle.mode === "host-managed" ? run.lifecycle.retrievedMemories : run.events.retrievedMemories;
}

function committedSession(run: AgentRunResult): boolean {
  return run.lifecycle.mode === "host-managed"
    ? run.lifecycle.commitSucceeded && run.lifecycle.commitStatus === "committed"
    : run.sessionsBeforeCleanup.some((session) => session.status === "committed");
}

function collectPairs(runs: AgentRunResult[], baselineArm: AgentBaselineArm): AgentPair[] {
  const grouped = new Map<string, AgentRunResult[]>();
  for (const run of runs) {
    const key = `${run.taskId}\0${run.iteration}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  const pairs: AgentPair[] = [];
  for (const group of grouped.values()) {
    const baseline = group.find((run) => run.arm === baselineArm);
    const repoMind = group.find((run) => run.arm === "repomind");
    if (baseline && repoMind) pairs.push({ taskId: baseline.taskId, iteration: baseline.iteration, baseline, repoMind });
  }
  return pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.iteration - b.iteration);
}

function summarizeMetric(pairs: AgentPair[], definition: typeof METRICS[number]): PairedMetric {
  const baseline = pairs.map((pair) => metricValue(pair.baseline, definition.key));
  const repoMind = pairs.map((pair) => metricValue(pair.repoMind, definition.key));
  const deltas = repoMind.map((value, index) => value - baseline[index]!);
  const baselineMean = mean(baseline);
  let repoMindWins = 0;
  let ties = 0;
  let repoMindLosses = 0;
  for (const delta of deltas) {
    if (delta === 0) ties += 1;
    else if ((definition.preferred === "higher" && delta > 0) || (definition.preferred === "lower" && delta < 0)) repoMindWins += 1;
    else repoMindLosses += 1;
  }
  return {
    ...definition,
    pairs: pairs.length,
    baselineMean: round(baselineMean),
    repoMindMean: round(mean(repoMind)),
    meanDelta: round(mean(deltas)),
    medianDelta: round(median(deltas)),
    relativeDeltaPercent: baselineMean === 0 ? null : round((mean(deltas) / Math.abs(baselineMean)) * 100),
    repoMindWins, ties, repoMindLosses,
  };
}

function pairedComparison(runs: AgentRunResult[], baselineArm: AgentBaselineArm): PairedComparison {
  const pairs = collectPairs(runs, baselineArm);
  const taskIds = [...new Set(pairs.map((pair) => pair.taskId))];
  return {
    baselineArm,
    pairs: pairs.length,
    overall: METRICS.map((definition) => summarizeMetric(pairs, definition)),
    tasks: taskIds.map((taskId) => {
      const selected = pairs.filter((pair) => pair.taskId === taskId);
      return { taskId, pairs: selected.length, metrics: METRICS.map((definition) => summarizeMetric(selected, definition)) };
    }),
  };
}

function metric(comparison: PairedComparison, key: PairedMetricKey): PairedMetric {
  return comparison.overall.find((entry) => entry.key === key)!;
}

function taskMetric(comparison: PairedComparison, taskId: string, key: PairedMetricKey): PairedMetric | null {
  return comparison.tasks.find((entry) => entry.taskId === taskId)?.metrics.find((entry) => entry.key === key) ?? null;
}

function evaluateAcceptance(
  criteria: AgentAcceptanceCriteria | undefined,
  integrityPassed: boolean,
  comparisons: AgentEvalReport["comparisons"],
  runs: AgentRunResult[],
): AgentEvalReport["acceptance"] {
  if (!criteria) return { status: "not-configured", criteria: null, checks: [] };
  const checks: AcceptanceCheck[] = [{
    id: "integrity", passed: integrityPassed, measured: integrityPassed, target: "true",
    detail: "Experiment integrity must pass before outcome acceptance is meaningful.",
  }];
  const noMemory = comparisons["no-memory"]!;
  const hidden = metric(noMemory, "hiddenSuccess");
  const duration = metric(noMemory, "wallDurationMs");
  const inputTokens = metric(noMemory, "inputTokens");
  const fileReads = metric(noMemory, "fileReads");
  const repoMindRuns = runs.filter((run) => run.arm === "repomind");
  const retrievalRate = repoMindRuns.length ? repoMindRuns.filter((run) => retrievedMemories(run) > 0).length / repoMindRuns.length : 0;
  const sessionCommitRate = repoMindRuns.length
    ? repoMindRuns.filter(committedSession).length / repoMindRuns.length
    : 0;
  if (criteria.minRepoMindHiddenPassRate !== undefined) checks.push({
    id: "repoMindHiddenPassRate", passed: hidden.repoMindMean >= criteria.minRepoMindHiddenPassRate,
    measured: hidden.repoMindMean, target: `>= ${criteria.minRepoMindHiddenPassRate}`, detail: "RepoMind hidden-check pass rate.",
  });
  if (criteria.minHiddenPassRateDelta !== undefined) checks.push({
    id: "hiddenPassRateDelta:no-memory", passed: hidden.meanDelta >= criteria.minHiddenPassRateDelta,
    measured: hidden.meanDelta, target: `>= ${criteria.minHiddenPassRateDelta}`, detail: "RepoMind minus no-memory hidden-check pass rate.",
  });
  const fullHistory = comparisons["full-history"];
  if (criteria.minFullHistoryHiddenPassRateDelta !== undefined) {
    const measured = fullHistory ? metric(fullHistory, "hiddenSuccess").meanDelta : false;
    checks.push({
      id: "hiddenPassRateDelta:full-history", passed: typeof measured === "number" && measured >= criteria.minFullHistoryHiddenPassRateDelta,
      measured, target: `>= ${criteria.minFullHistoryHiddenPassRateDelta}`, detail: "RepoMind minus full-history hidden-check pass rate.",
    });
  }
  if (criteria.minRetrievalRate !== undefined) checks.push({
    id: "retrievalRate", passed: retrievalRate >= criteria.minRetrievalRate,
    measured: round(retrievalRate), target: `>= ${criteria.minRetrievalRate}`, detail: "Share of RepoMind runs retrieving at least one memory.",
  });
  if (criteria.minSessionCommitRate !== undefined) checks.push({
    id: "sessionCommitRate", passed: sessionCommitRate >= criteria.minSessionCommitRate,
    measured: round(sessionCommitRate), target: `>= ${criteria.minSessionCommitRate}`, detail: "Share of RepoMind runs with a committed session.",
  });
  if (criteria.maxMeanDurationRegressionPercent !== undefined) checks.push({
    id: "durationRegression:no-memory", passed: (duration.relativeDeltaPercent ?? 0) <= criteria.maxMeanDurationRegressionPercent,
    measured: duration.relativeDeltaPercent ?? 0, target: `<= ${criteria.maxMeanDurationRegressionPercent}%`, detail: "Mean wall-time regression against no-memory.",
  });
  if (criteria.maxFullHistoryDurationRegressionPercent !== undefined) {
    const measured = fullHistory ? metric(fullHistory, "wallDurationMs").relativeDeltaPercent ?? 0 : false;
    checks.push({
      id: "durationRegression:full-history", passed: typeof measured === "number" && measured <= criteria.maxFullHistoryDurationRegressionPercent,
      measured, target: `<= ${criteria.maxFullHistoryDurationRegressionPercent}%`, detail: "Mean wall-time regression against full-history.",
    });
  }
  if (criteria.requireEfficiencyImprovement !== undefined) {
    const improved = inputTokens.meanDelta < 0 || fileReads.meanDelta < 0;
    checks.push({
      id: "efficiencyImprovement", passed: criteria.requireEfficiencyImprovement ? improved : true,
      measured: improved, target: criteria.requireEfficiencyImprovement ? "true" : "not required",
      detail: "At least one of mean input tokens or file reads improved against no-memory.",
    });
  }
  const addTaskWins = (ids: string[], comparison: PairedComparison | null, baseline: AgentBaselineArm): void => {
    for (const taskId of ids) {
      const taskHidden = comparison ? taskMetric(comparison, taskId, "hiddenSuccess") : null;
      checks.push({
        id: `requiredTaskWin:${baseline}:${taskId}`, passed: taskHidden !== null && taskHidden.meanDelta > 0,
        measured: taskHidden?.meanDelta ?? false, target: "> 0",
        detail: taskHidden ? `Required positive hidden-check delta against ${baseline}.` : `No complete ${baseline} pair was available.`,
      });
    }
  };
  addTaskWins(criteria.requiredTaskWins ?? [], noMemory, "no-memory");
  addTaskWins(criteria.requiredFullHistoryTaskWins ?? [], fullHistory, "full-history");
  return { status: checks.every((check) => check.passed) ? "passed" : "failed", criteria, checks };
}

function summarizeArm(runs: AgentRunResult[]): ArmSummary {
  const presentMean = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    return present.length ? round(mean(present)) : null;
  };
  return {
    runs: runs.length,
    agentCleanExits: runs.filter((run) => run.agentExitCode === 0).length,
    publicPasses: runs.filter((run) => passed(run.publicChecks)).length,
    hiddenPasses: runs.filter((run) => passed(run.hiddenChecks)).length,
    meanWallDurationMs: round(mean(runs.map((run) => run.totalLifecycleMs))),
    meanStartMs: presentMean(runs.map((run) => run.startMs)),
    meanAgentMs: round(mean(runs.map((run) => run.agentMs))),
    meanCommitMs: presentMean(runs.map((run) => run.commitMs)),
    meanTotalLifecycleMs: round(mean(runs.map((run) => run.totalLifecycleMs))),
    meanInputTokens: round(mean(runs.map((run) => run.events.tokens.input))),
    meanOutputTokens: round(mean(runs.map((run) => run.events.tokens.output))),
    meanFileReads: round(mean(runs.map((run) => run.events.fileReads))),
    repoMindCalls: runs.reduce((sum, run) => sum + run.events.repoMindCalls, 0),
    retrievedMemories: runs.reduce((sum, run) => sum + retrievedMemories(run), 0),
  };
}

export function buildAgentReport(input: BuildAgentReportInput): AgentEvalReport {
  const enabledArms: AgentArm[] = input.runs.some((run) => run.arm === "full-history")
    ? ["no-memory", "full-history", "repomind"]
    : ["no-memory", "repomind"];
  const arms = Object.fromEntries(enabledArms.map((arm) => [arm, summarizeArm(input.runs.filter((run) => run.arm === arm))]));
  const failures: string[] = [];
  const groups = new Map<string, AgentRunResult[]>();
  for (const run of input.runs) {
    const key = `${run.taskId}\0${run.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    for (const arm of enabledArms) {
      if (group.filter((run) => run.arm === arm).length !== 1) failures.push(`${first.taskId}/iteration-${first.iteration}: expected exactly one ${arm} run`);
    }
  }
  for (const run of input.runs) {
    const label = `${run.taskId}/${run.arm}-${run.iteration}`;
    const expectedLifecycle = input.repoMindLifecycle ?? "agent-managed";
    if (run.agentExitCode !== 0) failures.push(`${label}: agent exited with ${run.agentExitCode ?? run.agentSignal ?? "unknown"}`);
    if (run.baseCommit !== run.requestedCommit) failures.push(`${label}: clone is not at the resolved base commit`);
    if (run.unexpectedChanges.length) failures.push(`${label}: unexpected changes: ${run.unexpectedChanges.join(", ")}`);
    if ([...run.publicChecks, ...run.hiddenChecks].some((check) => check.exitCode === null)) failures.push(`${label}: a check could not be executed`);
    if (run.openSessionsAfterCleanup) failures.push(`${label}: open RepoMind sessions remain after cleanup`);
    if ([run.startMs, run.agentMs, run.commitMs, run.totalLifecycleMs].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
      failures.push(`${label}: lifecycle timing contains an invalid value`);
    }
    if (run.lifecycle.error) failures.push(`${label}: lifecycle error: ${run.lifecycle.error}`);
    if (run.wallDurationMs !== run.totalLifecycleMs) failures.push(`${label}: wall time does not equal total lifecycle time`);
    if (run.lifecycle.mode === "host-managed") {
      const components = (run.startMs ?? 0) + run.agentMs + (run.commitMs ?? 0);
      if (Math.abs(components - run.totalLifecycleMs) > 2) failures.push(`${label}: lifecycle phases do not add up to total time`);
    }
    if (run.arm === "repomind" && run.lifecycle.mode === "agent-managed" && run.events.repoMindCalls === 0) failures.push(`${label}: RepoMind MCP was not called`);
    if (run.arm === "repomind" && run.lifecycle.mode === "host-managed") {
      if (run.events.repoMindCalls !== 0) failures.push(`${label}: host-managed Agent called RepoMind MCP`);
      if (!run.lifecycle.startSucceeded) failures.push(`${label}: host-managed session start failed`);
      if (!run.lifecycle.commitSucceeded) failures.push(`${label}: host-managed session commit failed`);
    }
    if (run.arm === "repomind" && run.lifecycle.mode === "none") failures.push(`${label}: RepoMind lifecycle is missing`);
    if (run.arm === "repomind" && run.lifecycle.mode !== expectedLifecycle) failures.push(`${label}: RepoMind lifecycle does not match report mode ${expectedLifecycle}`);
    if (run.arm !== "repomind" && run.lifecycle.mode !== "none") failures.push(`${label}: ${run.arm} arm has a RepoMind lifecycle`);
    if (run.arm !== "repomind" && run.events.repoMindCalls !== 0) failures.push(`${label}: ${run.arm} arm called RepoMind MCP`);
  }
  const comparisons: AgentEvalReport["comparisons"] = {
    "no-memory": pairedComparison(input.runs, "no-memory"),
    "full-history": enabledArms.includes("full-history") ? pairedComparison(input.runs, "full-history") : null,
  };
  const integrity = { passed: failures.length === 0, failures };
  return {
    version: 5, generatedAt: new Date().toISOString(), name: input.name, runner: input.runner,
    model: input.model, repeat: input.repeat, repoMindLifecycle: input.repoMindLifecycle ?? "agent-managed", outputDirectory: input.outputDirectory,
    provenance: input.provenance, runs: input.runs, arms, comparisons, integrity,
    acceptance: evaluateAcceptance(input.acceptanceCriteria, integrity.passed, comparisons, input.runs),
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(3);
}

const formatPercent = (value: number | null): string => value === null ? "n/a" : `${formatMetric(value)}%`;

function comparisonMarkdown(comparison: PairedComparison): string {
  const pairedRows = comparison.overall.map((entry) =>
    `| ${entry.key} | ${entry.preferred} | ${formatMetric(entry.baselineMean)} | ${formatMetric(entry.repoMindMean)} | ${formatMetric(entry.meanDelta)} | ${formatPercent(entry.relativeDeltaPercent)} | ${entry.repoMindWins}/${entry.ties}/${entry.repoMindLosses} |`,
  ).join("\n");
  const taskRows = comparison.tasks.map((task) => {
    const hidden = task.metrics.find((entry) => entry.key === "hiddenSuccess")!;
    const duration = task.metrics.find((entry) => entry.key === "wallDurationMs")!;
    const tokens = task.metrics.find((entry) => entry.key === "inputTokens")!;
    const reads = task.metrics.find((entry) => entry.key === "fileReads")!;
    return `| ${task.taskId} | ${task.pairs} | ${formatMetric(hidden.baselineMean)} | ${formatMetric(hidden.repoMindMean)} | ${formatPercent(duration.relativeDeltaPercent)} | ${formatPercent(tokens.relativeDeltaPercent)} | ${formatPercent(reads.relativeDeltaPercent)} |`;
  }).join("\n");
  return `## RepoMind vs ${comparison.baselineArm}\n\nDeltas are RepoMind minus ${comparison.baselineArm}. Win/tie/loss uses the preferred direction.\n\n| Metric | Preferred | Baseline mean | RepoMind mean | Mean delta | Delta % | Win/tie/loss |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${pairedRows}\n\n### Per-task results\n\n| Task | Pairs | Hidden baseline | Hidden RepoMind | Duration delta | Input-token delta | File-read delta |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${taskRows}`;
}

export function renderAgentMarkdown(report: AgentEvalReport): string {
  const armRows = (["no-memory", "full-history", "repomind"] as const).flatMap((arm) => {
    const value = report.arms[arm];
    return value ? [`| ${arm} | ${value.hiddenPasses}/${value.runs} | ${value.publicPasses}/${value.runs} | ${(value.meanTotalLifecycleMs / 1000).toFixed(1)} s | ${value.meanStartMs === null ? "n/a" : `${value.meanStartMs.toFixed(1)} ms`} | ${value.meanAgentMs.toFixed(1)} ms | ${value.meanCommitMs === null ? "n/a" : `${value.meanCommitMs.toFixed(1)} ms`} | ${Math.round(value.meanInputTokens)} | ${Math.round(value.meanOutputTokens)} | ${value.meanFileReads.toFixed(1)} |`] : [];
  }).join("\n");
  const comparisonSections = (["no-memory", "full-history"] as const).flatMap((arm) => {
    const comparison = report.comparisons[arm];
    return comparison ? [comparisonMarkdown(comparison)] : [];
  }).join("\n\n");
  const runs = report.runs.map((run) =>
    `| ${run.taskId} | ${run.arm}-${run.iteration} | ${run.lifecycle.mode} | ${passed(run.hiddenChecks) ? "pass" : "fail"} | ${passed(run.publicChecks) ? "pass" : "fail"} | ${run.startMs === null ? "n/a" : run.startMs.toFixed(1)} | ${run.agentMs.toFixed(1)} | ${run.commitMs === null ? "n/a" : run.commitMs.toFixed(1)} | ${run.totalLifecycleMs.toFixed(1)} | ${run.events.tokens.input} | ${run.events.fileReads} | ${run.events.repoMindCalls} |`,
  ).join("\n");
  const acceptanceRows = report.acceptance.checks.map((check) =>
    `| ${check.id} | ${check.passed ? "yes" : "NO"} | ${String(check.measured)} | ${check.target} | ${check.detail} |`,
  ).join("\n");
  const dirty = report.provenance.repoMindDirty === null ? "unavailable" : String(report.provenance.repoMindDirty);
  const provenanceRows = Object.entries(report.provenance.taskBaseCommits).map(([task, commit]) => `| task:${task} | \`${commit}\` |`).join("\n");
  return `# RepoMind controlled agent benchmark\n\nManifest: ${report.name}\n\nRunner: ${report.runner} / ${report.model}\n\nRepoMind lifecycle: ${report.repoMindLifecycle}\n\nRepeat: ${report.repeat}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nAcceptance: **${report.acceptance.status}**\n\n## Provenance\n\n| Field | Value |\n| --- | --- |\n| RepoMind | ${report.provenance.repoMindVersion} / \`${report.provenance.repoMindCommit ?? "not-a-git-checkout"}\` |\n| RepoMind worktree dirty | ${dirty} |\n| Node | ${report.provenance.node} |\n| OS | ${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch} |\n| Runner version | ${report.provenance.runnerVersion ?? "unavailable"} |\n| Manifest SHA-256 | \`${report.provenance.manifestSha256}\` |\n${provenanceRows}\n\n## Results\n\n| Arm | Hidden checks | Public checks | Mean total | Mean start | Mean Agent | Mean commit | Mean input tokens | Mean output tokens | Mean file reads |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows}\n\n${comparisonSections}\n\n## Acceptance checks\n\n${acceptanceRows ? `| Check | Passed | Measured | Target | Detail |\n| --- | --- | ---: | --- | --- |\n${acceptanceRows}` : "No acceptance criteria configured."}\n\n## Runs\n\n| Task | Run | Lifecycle | Hidden | Public | Start ms | Agent ms | Commit ms | Total ms | Input tokens | File reads | RepoMind calls |\n| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${runs}\n\n## Integrity failures\n\n${report.integrity.failures.length ? report.integrity.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}
