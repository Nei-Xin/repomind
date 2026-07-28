import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RepoMindError } from "../../errors.js";
import type { AgentBaselineArm, AgentEvalReport, AgentRunResult, PairedMetricKey } from "./report.js";

const METRICS: PairedMetricKey[] = ["hiddenSuccess", "publicSuccess", "wallDurationMs", "inputTokens", "outputTokens", "fileReads"];

export interface AggregateMetric {
  key: PairedMetricKey;
  pairs: number;
  baselineMean: number;
  repoMindMean: number;
  meanDelta: number;
  confidence95: { low: number; high: number };
  repoMindWins: number;
  ties: number;
  repoMindLosses: number;
}

export interface AgentAggregateReport {
  version: 1;
  generatedAt: string;
  reports: Array<{
    path: string;
    sha256: string;
    name: string;
    model: string;
    os: string;
    integrity: boolean;
    acceptance: string;
  }>;
  reportCount: number;
  runCount: number;
  models: string[];
  environments: string[];
  integrity: { passed: boolean; failedReports: string[] };
  comparisons: Record<AgentBaselineArm, AggregateMetric[] | null>;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function metricValue(run: AgentRunResult, key: PairedMetricKey): number {
  switch (key) {
    case "hiddenSuccess": return run.hiddenChecks.every((check) => check.passed) ? 1 : 0;
    case "publicSuccess": return run.publicChecks.every((check) => check.passed) ? 1 : 0;
    case "wallDurationMs": return run.totalLifecycleMs ?? run.wallDurationMs;
    case "inputTokens": return run.events.tokens.input;
    case "outputTokens": return run.events.tokens.output;
    case "fileReads": return run.events.fileReads;
  }
}

export interface LoadedAgentReport {
  report: AgentEvalReport;
  path: string;
  sha256: string;
}

export function loadAgentReport(path: string): LoadedAgentReport {
  const absolute = resolve(path);
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readFileSync(absolute);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read agent report ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const candidate = value as Partial<AgentEvalReport>;
  const version = (value as { version?: unknown }).version;
  if ((version !== 4 && version !== 5) || !Array.isArray(candidate.runs) || !candidate.provenance) {
    throw new RepoMindError("INVALID_INPUT", `Agent report ${path} is not report schema version 4 or 5`);
  }
  return { report: candidate as AgentEvalReport, path: absolute, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function pairedValues(reports: AgentEvalReport[], baselineArm: AgentBaselineArm, key: PairedMetricKey): Array<{ baseline: number; repoMind: number }> {
  const values: Array<{ baseline: number; repoMind: number }> = [];
  for (const report of reports) {
    const groups = new Map<string, AgentRunResult[]>();
    for (const run of report.runs) {
      const id = `${run.taskId}\0${run.iteration}`;
      groups.set(id, [...(groups.get(id) ?? []), run]);
    }
    for (const group of groups.values()) {
      const baseline = group.find((run) => run.arm === baselineArm);
      const repoMind = group.find((run) => run.arm === "repomind");
      if (baseline && repoMind) values.push({ baseline: metricValue(baseline, key), repoMind: metricValue(repoMind, key) });
    }
  }
  return values;
}

function summarize(values: Array<{ baseline: number; repoMind: number }>, key: PairedMetricKey): AggregateMetric {
  const deltas = values.map((value) => value.repoMind - value.baseline);
  const mean = (items: number[]): number => items.reduce((sum, value) => sum + value, 0) / Math.max(1, items.length);
  const meanDelta = mean(deltas);
  const variance = deltas.length > 1
    ? deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1)
    : 0;
  const margin = deltas.length ? 1.96 * Math.sqrt(variance / deltas.length) : 0;
  const preferred = key === "hiddenSuccess" || key === "publicSuccess" ? "higher" : "lower";
  let repoMindWins = 0;
  let ties = 0;
  let repoMindLosses = 0;
  for (const delta of deltas) {
    if (delta === 0) ties += 1;
    else if ((preferred === "higher" && delta > 0) || (preferred === "lower" && delta < 0)) repoMindWins += 1;
    else repoMindLosses += 1;
  }
  return {
    key, pairs: values.length,
    baselineMean: round(mean(values.map((value) => value.baseline))),
    repoMindMean: round(mean(values.map((value) => value.repoMind))),
    meanDelta: round(meanDelta),
    confidence95: { low: round(meanDelta - margin), high: round(meanDelta + margin) },
    repoMindWins, ties, repoMindLosses,
  };
}

export function aggregateAgentReports(paths: string[]): AgentAggregateReport {
  if (!paths.length) throw new RepoMindError("INVALID_INPUT", "At least one agent report is required");
  const loaded = paths.map(loadAgentReport);
  const reports = loaded.map((entry) => entry.report);
  const failedReports = loaded.filter((entry) => !entry.report.integrity.passed).map((entry) => entry.path);
  const hasFullHistory = reports.some((report) => report.runs.some((run) => run.arm === "full-history"));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    reports: loaded.map(({ report, path, sha256 }) => ({
      path, sha256, name: report.name, model: report.model,
      os: `${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch}`,
      integrity: report.integrity.passed, acceptance: report.acceptance.status,
    })),
    reportCount: reports.length,
    runCount: reports.reduce((sum, report) => sum + report.runs.length, 0),
    models: [...new Set(reports.map((report) => report.model))].sort(),
    environments: [...new Set(reports.map((report) => `${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch}`))].sort(),
    integrity: { passed: failedReports.length === 0, failedReports },
    comparisons: {
      "no-memory": METRICS.map((key) => summarize(pairedValues(reports, "no-memory", key), key)),
      "full-history": hasFullHistory ? METRICS.map((key) => summarize(pairedValues(reports, "full-history", key), key)) : null,
    },
  };
}

export function renderAgentAggregateMarkdown(report: AgentAggregateReport): string {
  const sources = report.reports.map((entry) => `| ${entry.name} | ${entry.model} | ${entry.os} | ${entry.integrity ? "yes" : "NO"} | ${entry.acceptance} | \`${entry.sha256}\` |`).join("\n");
  const comparisons = (["no-memory", "full-history"] as const).flatMap((arm) => {
    const metrics = report.comparisons[arm];
    if (!metrics) return [];
    const rows = metrics.map((metric) => `| ${metric.key} | ${metric.pairs} | ${metric.baselineMean} | ${metric.repoMindMean} | ${metric.meanDelta} | ${metric.confidence95.low} to ${metric.confidence95.high} | ${metric.repoMindWins}/${metric.ties}/${metric.repoMindLosses} |`).join("\n");
    return [`## RepoMind vs ${arm}\n\n| Metric | Pairs | Baseline mean | RepoMind mean | Mean delta | 95% interval | Win/tie/loss |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}`];
  }).join("\n\n");
  return `# RepoMind aggregate agent benchmark\n\nReports: ${report.reportCount}\n\nRuns: ${report.runCount}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nModels: ${report.models.join(", ")}\n\nEnvironments: ${report.environments.join(", ")}\n\n## Source reports\n\n| Name | Model | OS | Integrity | Acceptance | SHA-256 |\n| --- | --- | --- | --- | --- | --- |\n${sources}\n\n${comparisons}\n`;
}

export function writeAgentAggregateReport(report: AgentAggregateReport, outputDirectory: string): void {
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(resolve(output, "summary.md"), renderAgentAggregateMarkdown(report), "utf8");
}
