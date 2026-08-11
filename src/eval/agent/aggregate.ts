import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RepoMindError } from "../../errors.js";
import type { AgentBaselineArm, AgentEvalReport, AgentRunResult, PairedMetricKey } from "./report.js";

const METRICS: PairedMetricKey[] = ["hiddenSuccess", "publicSuccess", "wallDurationMs", "inputTokens", "outputTokens", "fileReads"];

export type AgentReportSchemaVersion = 4 | 5 | 6 | 7;

export interface AggregateTelemetryCoverage {
  total: number;
  full: number;
  unavailable: number;
  notApplicable: number;
  missing: number;
}

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
  version: 2;
  generatedAt: string;
  reports: Array<{
    path: string;
    sha256: string;
    schemaVersion: AgentReportSchemaVersion;
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
  telemetryCoverage: {
    context: AggregateTelemetryCoverage;
    maintenance: AggregateTelemetryCoverage;
    quality: AggregateTelemetryCoverage;
  };
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
  schemaVersion: AgentReportSchemaVersion;
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
  if ((version !== 4 && version !== 5 && version !== 6 && version !== 7) || !Array.isArray(candidate.runs) || !candidate.provenance) {
    throw new RepoMindError("INVALID_INPUT", `Agent report ${path} is not report schema version 4, 5, 6, or 7`);
  }
  return {
    report: candidate as AgentEvalReport,
    schemaVersion: version,
    path: absolute,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

type TelemetryState = "full" | "unavailable" | "notApplicable" | "missing";

function telemetryAvailability(run: AgentRunResult, field: "contextTelemetry" | "maintenanceTelemetry"): TelemetryState {
  const record = run as unknown as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return "missing";
  const telemetry = record[field];
  if (!telemetry || typeof telemetry !== "object") return "unavailable";
  const availability = (telemetry as { availability?: unknown }).availability;
  if (availability === "full") return "full";
  if (availability === "not-applicable") return "notApplicable";
  return "unavailable";
}

function qualityAvailability(run: AgentRunResult): TelemetryState {
  const record = run as unknown as Record<string, unknown>;
  if (!Object.hasOwn(record, "quality")) return "missing";
  if (record.quality && typeof record.quality === "object") return "full";
  const lifecycle = record.lifecycle as { mode?: unknown } | undefined;
  return run.arm === "repomind" && lifecycle?.mode === "host-managed" ? "unavailable" : "notApplicable";
}

function coverage(runs: AgentRunResult[], classify: (run: AgentRunResult) => TelemetryState): AggregateTelemetryCoverage {
  const result: AggregateTelemetryCoverage = {
    total: runs.length, full: 0, unavailable: 0, notApplicable: 0, missing: 0,
  };
  for (const run of runs) result[classify(run)] += 1;
  return result;
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
  const runs = reports.flatMap((report) => report.runs);
  const failedReports = loaded.filter((entry) => !entry.report.integrity.passed).map((entry) => entry.path);
  const hasFullHistory = reports.some((report) => report.runs.some((run) => run.arm === "full-history"));
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    reports: loaded.map(({ report, schemaVersion, path, sha256 }) => ({
      path, sha256, schemaVersion, name: report.name, model: report.model,
      os: `${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch}`,
      integrity: report.integrity.passed, acceptance: report.acceptance.status,
    })),
    reportCount: reports.length,
    runCount: reports.reduce((sum, report) => sum + report.runs.length, 0),
    models: [...new Set(reports.map((report) => report.model))].sort(),
    environments: [...new Set(reports.map((report) => `${report.provenance.os.platform} ${report.provenance.os.release} ${report.provenance.os.arch}`))].sort(),
    integrity: { passed: failedReports.length === 0, failedReports },
    telemetryCoverage: {
      context: coverage(runs, (run) => telemetryAvailability(run, "contextTelemetry")),
      maintenance: coverage(runs, (run) => telemetryAvailability(run, "maintenanceTelemetry")),
      quality: coverage(runs, qualityAvailability),
    },
    comparisons: {
      "no-memory": METRICS.map((key) => summarize(pairedValues(reports, "no-memory", key), key)),
      "full-history": hasFullHistory ? METRICS.map((key) => summarize(pairedValues(reports, "full-history", key), key)) : null,
    },
  };
}

export function renderAgentAggregateMarkdown(report: AgentAggregateReport): string {
  const sources = report.reports.map((entry) => `| ${entry.name} | v${entry.schemaVersion} | ${entry.model} | ${entry.os} | ${entry.integrity ? "yes" : "NO"} | ${entry.acceptance} | \`${entry.sha256}\` |`).join("\n");
  const telemetryRows = (["context", "maintenance", "quality"] as const).map((key) => {
    const value = report.telemetryCoverage[key];
    return `| ${key} | ${value.full} | ${value.unavailable} | ${value.notApplicable} | ${value.missing} | ${value.total} |`;
  }).join("\n");
  const comparisons = (["no-memory", "full-history"] as const).flatMap((arm) => {
    const metrics = report.comparisons[arm];
    if (!metrics) return [];
    const rows = metrics.map((metric) => `| ${metric.key} | ${metric.pairs} | ${metric.baselineMean} | ${metric.repoMindMean} | ${metric.meanDelta} | ${metric.confidence95.low} to ${metric.confidence95.high} | ${metric.repoMindWins}/${metric.ties}/${metric.repoMindLosses} |`).join("\n");
    return [`## RepoMind vs ${arm}\n\n| Metric | Pairs | Baseline mean | RepoMind mean | Mean delta | 95% interval | Win/tie/loss |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}`];
  }).join("\n\n");
  return `# RepoMind aggregate agent benchmark\n\nReports: ${report.reportCount}\n\nRuns: ${report.runCount}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nModels: ${report.models.join(", ")}\n\nEnvironments: ${report.environments.join(", ")}\n\n## Source reports\n\n| Name | Schema | Model | OS | Integrity | Acceptance | SHA-256 |\n| --- | --- | --- | --- | --- | --- | --- |\n${sources}\n\n## Telemetry coverage\n\nMissing means the source run did not contain the field; it is never interpreted as a zero measurement.\n\n| Telemetry | Full | Unavailable | Not applicable | Missing | Total |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${telemetryRows}\n\n${comparisons}\n`;
}

export function writeAgentAggregateReport(report: AgentAggregateReport, outputDirectory: string): void {
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(resolve(output, "summary.md"), renderAgentAggregateMarkdown(report), "utf8");
}
