import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RepoMindError } from "../../errors.js";
import { parseAgentEvents } from "./events.js";
import { loadAgentReport } from "./aggregate.js";
import type { AgentArm, AgentBaselineArm, AgentRunResult } from "./report.js";

export type AgentPhaseKey = "ordinary" | "sessionStart" | "sessionCommit" | "repoMindOther";
export type ProfileMetricKey = "wallDurationMs" | "observedDurationMs" | "unobservedDurationMs" | "turns" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "toolCalls";

interface TokenCounts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentPhaseMeasurement {
  turns: number;
  repoMindCalls: number;
  timedRepoMindCalls: number;
  directRepoMindToolDurationMs: number;
  toolTurnCycleDurationMs: number;
  followingTurns: number;
  followingCycleDurationMs: number;
  toolTurnTokens: TokenCounts;
  followingTurnTokens: TokenCounts;
}

export interface AgentRunProfile {
  taskId: string;
  arm: AgentArm;
  iteration: number;
  rawPath: string;
  wallDurationMs: number;
  observedDurationMs: number;
  unobservedDurationMs: number;
  turns: number;
  toolCalls: number;
  tokens: TokenCounts;
  malformedLines: number;
  phases: Record<AgentPhaseKey, AgentPhaseMeasurement>;
}

export interface AgentArmProfile {
  runs: number;
  meanWallDurationMs: number;
  meanObservedDurationMs: number;
  meanUnobservedDurationMs: number;
  meanTurns: number;
  meanToolCalls: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCacheReadTokens: number;
}

export interface ProfileMetric {
  key: ProfileMetricKey;
  pairs: number;
  baselineMean: number;
  repoMindMean: number;
  meanDelta: number;
  relativeDeltaPercent: number | null;
  confidence95: { low: number; high: number };
  repoMindWins: number;
  ties: number;
  repoMindLosses: number;
}

export interface AgentProtocolPhaseSummary {
  calls: number;
  turns: number;
  timedCalls: number;
  meanDirectToolDurationMs: number;
  meanToolTurnCycleDurationMs: number;
  meanFollowingCycleDurationMs: number;
  meanToolTurnInputTokens: number;
  meanToolTurnOutputTokens: number;
  meanFollowingTurnInputTokens: number;
  meanFollowingTurnOutputTokens: number;
}

export interface AgentProfileReport {
  version: 1;
  generatedAt: string;
  source: {
    reportPath: string;
    reportSha256: string;
    rawDirectory: string;
    name: string;
    model: string;
    repoMindVersion: string;
    repoMindCommit: string | null;
  };
  integrity: { passed: boolean; failures: string[] };
  runs: AgentRunProfile[];
  arms: Partial<Record<AgentArm, AgentArmProfile>>;
  comparisons: Record<AgentBaselineArm, ProfileMetric[] | null>;
  repoMindProtocol: Record<Exclude<AgentPhaseKey, "ordinary">, AgentProtocolPhaseSummary>;
}

interface TraceTool {
  name: string;
  directDurationMs: number | null;
}

interface TraceStep {
  startedAt: number | null;
  finishedAt: number | null;
  cycleDurationMs: number;
  tokens: TokenCounts;
  tools: TraceTool[];
}

const PROFILE_METRICS: ProfileMetricKey[] = [
  "wallDurationMs", "observedDurationMs", "unobservedDurationMs", "turns",
  "inputTokens", "outputTokens", "cacheReadTokens", "toolCalls",
];
const PHASES: AgentPhaseKey[] = ["ordinary", "sessionStart", "sessionCommit", "repoMindOther"];

const emptyTokens = (): TokenCounts => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
const emptyPhase = (): AgentPhaseMeasurement => ({
  turns: 0, repoMindCalls: 0, timedRepoMindCalls: 0,
  directRepoMindToolDurationMs: 0, toolTurnCycleDurationMs: 0,
  followingTurns: 0, followingCycleDurationMs: 0,
  toolTurnTokens: emptyTokens(), followingTurnTokens: emptyTokens(),
});
const round = (value: number): number => Math.round(value * 1000) / 1000;
const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addTokens(target: TokenCounts, source: TokenCounts): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function eventTokens(part: Record<string, unknown> | undefined): TokenCounts {
  const value = part?.tokens as Record<string, unknown> | undefined;
  const cache = value?.cache as Record<string, unknown> | undefined;
  return {
    input: Number(value?.input ?? 0), output: Number(value?.output ?? 0),
    reasoning: Number(value?.reasoning ?? 0), cacheRead: Number(cache?.read ?? 0),
    cacheWrite: Number(cache?.write ?? 0),
  };
}

function traceSteps(events: Array<Record<string, unknown>>): { steps: TraceStep[]; firstAt: number | null; lastAt: number | null } {
  const timestamps = events.map((event) => number(event.timestamp)).filter((value): value is number => value !== null);
  const firstAt = timestamps.length ? Math.min(...timestamps) : null;
  const lastAt = timestamps.length ? Math.max(...timestamps) : null;
  const steps: TraceStep[] = [];
  let current: Omit<TraceStep, "cycleDurationMs"> | null = null;
  let previousFinishedAt: number | null = null;
  const finish = (): void => {
    if (!current) return;
    const cycleStart = previousFinishedAt ?? firstAt ?? current.startedAt ?? current.finishedAt;
    const cycleEnd = current.finishedAt;
    const cycleDurationMs = cycleStart !== null && cycleEnd !== null ? Math.max(0, cycleEnd - cycleStart) : 0;
    steps.push({ ...current, cycleDurationMs });
    if (cycleEnd !== null) previousFinishedAt = cycleEnd;
    current = null;
  };
  for (const event of events) {
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "step_start") {
      finish();
      current = { startedAt: number(event.timestamp), finishedAt: null, tokens: emptyTokens(), tools: [] };
      continue;
    }
    if (!current) current = { startedAt: null, finishedAt: null, tokens: emptyTokens(), tools: [] };
    if (event.type === "tool_use" && typeof part?.tool === "string") {
      const state = (part.state ?? {}) as Record<string, unknown>;
      const time = state.time as Record<string, unknown> | undefined;
      const started = number(time?.start);
      const ended = number(time?.end);
      current.tools.push({ name: part.tool, directDurationMs: started !== null && ended !== null ? Math.max(0, ended - started) : null });
    }
    if (event.type === "step_finish") {
      current.tokens = eventTokens(part);
      current.finishedAt = number(event.timestamp);
      finish();
    }
  }
  finish();
  return { steps, firstAt, lastAt };
}

function classify(step: TraceStep): AgentPhaseKey {
  const names = step.tools.map((tool) => tool.name).filter((name) => name.startsWith("repomind_"));
  const starts = names.includes("repomind_repo_session_start");
  const commits = names.includes("repomind_repo_session_commit");
  if (starts && !commits) return "sessionStart";
  if (commits && !starts) return "sessionCommit";
  return names.length ? "repoMindOther" : "ordinary";
}

function phaseMeasurements(steps: TraceStep[]): Record<AgentPhaseKey, AgentPhaseMeasurement> {
  const phases = Object.fromEntries(PHASES.map((phase) => [phase, emptyPhase()])) as Record<AgentPhaseKey, AgentPhaseMeasurement>;
  for (const [index, step] of steps.entries()) {
    const phase = phases[classify(step)];
    const repoMindTools = step.tools.filter((tool) => tool.name.startsWith("repomind_"));
    phase.turns += 1;
    phase.repoMindCalls += repoMindTools.length;
    phase.timedRepoMindCalls += repoMindTools.filter((tool) => tool.directDurationMs !== null).length;
    phase.directRepoMindToolDurationMs += repoMindTools.reduce((sum, tool) => sum + (tool.directDurationMs ?? 0), 0);
    phase.toolTurnCycleDurationMs += step.cycleDurationMs;
    addTokens(phase.toolTurnTokens, step.tokens);
    const following = steps[index + 1];
    if (following) {
      phase.followingTurns += 1;
      phase.followingCycleDurationMs += following.cycleDurationMs;
      addTokens(phase.followingTurnTokens, following.tokens);
    }
  }
  return phases;
}

function expectedRawName(run: AgentRunResult): string {
  return `${run.taskId}-${run.arm}-${run.iteration}.jsonl`;
}

function profileRun(run: AgentRunResult, rawDirectory: string, failures: string[]): AgentRunProfile | null {
  const rawPath = join(rawDirectory, expectedRawName(run));
  let jsonl: string;
  try { jsonl = readFileSync(rawPath, "utf8"); } catch (error) {
    failures.push(`${expectedRawName(run)}: unable to read raw JSONL (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  const parsed = parseAgentEvents(jsonl);
  const traced = traceSteps(parsed.events);
  const tokens = traced.steps.reduce((total, step) => { addTokens(total, step.tokens); return total; }, emptyTokens());
  const rawToolCounts = new Map<string, number>();
  for (const step of traced.steps) for (const tool of step.tools) {
    rawToolCounts.set(tool.name, (rawToolCounts.get(tool.name) ?? 0) + 1);
  }
  const toolCalls = [...rawToolCounts.values()].reduce((sum, count) => sum + count, 0);
  const label = `${run.taskId}/${run.arm}-${run.iteration}`;
  if (parsed.malformedLines) failures.push(`${label}: ${parsed.malformedLines} malformed raw event line(s)`);
  if (traced.firstAt === null || traced.lastAt === null) failures.push(`${label}: raw events do not contain timestamps`);
  if (traced.steps.some((step) => step.finishedAt === null)) failures.push(`${label}: raw trace contains an unfinished step`);
  if (traced.steps.length !== run.events.turns) failures.push(`${label}: raw turn count ${traced.steps.length} does not match report ${run.events.turns}`);
  if ((["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const).some((key) => tokens[key] !== run.events.tokens[key])) {
    failures.push(`${label}: raw token totals do not match source report`);
  }
  const toolNames = new Set([...rawToolCounts.keys(), ...Object.keys(run.events.toolCalls)]);
  for (const name of toolNames) if ((rawToolCounts.get(name) ?? 0) !== (run.events.toolCalls[name] ?? 0)) {
    failures.push(`${label}: raw ${name} count ${rawToolCounts.get(name) ?? 0} does not match report ${run.events.toolCalls[name] ?? 0}`);
  }
  const observedDurationMs = traced.firstAt !== null && traced.lastAt !== null ? Math.max(0, traced.lastAt - traced.firstAt) : 0;
  const unobservedDurationMs = run.wallDurationMs - observedDurationMs;
  if (unobservedDurationMs < -1000) failures.push(`${label}: raw event span exceeds wall time by ${round(-unobservedDurationMs)} ms`);
  const phases = phaseMeasurements(traced.steps);
  if (run.arm === "repomind") for (const phase of [phases.sessionStart, phases.sessionCommit, phases.repoMindOther]) {
    if (phase.repoMindCalls !== phase.timedRepoMindCalls) failures.push(`${label}: ${phase.repoMindCalls - phase.timedRepoMindCalls} RepoMind call(s) lack direct timing`);
  }
  return {
    taskId: run.taskId, arm: run.arm, iteration: run.iteration, rawPath,
    wallDurationMs: run.wallDurationMs, observedDurationMs: round(observedDurationMs),
    unobservedDurationMs: round(unobservedDurationMs), turns: traced.steps.length,
    toolCalls, tokens, malformedLines: parsed.malformedLines, phases,
  };
}

function summarizeArm(runs: AgentRunProfile[]): AgentArmProfile {
  return {
    runs: runs.length,
    meanWallDurationMs: round(mean(runs.map((run) => run.wallDurationMs))),
    meanObservedDurationMs: round(mean(runs.map((run) => run.observedDurationMs))),
    meanUnobservedDurationMs: round(mean(runs.map((run) => run.unobservedDurationMs))),
    meanTurns: round(mean(runs.map((run) => run.turns))),
    meanToolCalls: round(mean(runs.map((run) => run.toolCalls))),
    meanInputTokens: round(mean(runs.map((run) => run.tokens.input))),
    meanOutputTokens: round(mean(runs.map((run) => run.tokens.output))),
    meanCacheReadTokens: round(mean(runs.map((run) => run.tokens.cacheRead))),
  };
}

function metricValue(run: AgentRunProfile, key: ProfileMetricKey): number {
  switch (key) {
    case "wallDurationMs": return run.wallDurationMs;
    case "observedDurationMs": return run.observedDurationMs;
    case "unobservedDurationMs": return run.unobservedDurationMs;
    case "turns": return run.turns;
    case "inputTokens": return run.tokens.input;
    case "outputTokens": return run.tokens.output;
    case "cacheReadTokens": return run.tokens.cacheRead;
    case "toolCalls": return run.toolCalls;
  }
}

function comparison(runs: AgentRunProfile[], baselineArm: AgentBaselineArm): ProfileMetric[] | null {
  const pairs: Array<{ baseline: AgentRunProfile; repoMind: AgentRunProfile }> = [];
  const groups = new Map<string, AgentRunProfile[]>();
  for (const run of runs) {
    const key = `${run.taskId}\0${run.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const group of groups.values()) {
    const baseline = group.find((run) => run.arm === baselineArm);
    const repoMind = group.find((run) => run.arm === "repomind");
    if (baseline && repoMind) pairs.push({ baseline, repoMind });
  }
  if (!pairs.length) return null;
  return PROFILE_METRICS.map((key) => {
    const baseline = pairs.map((pair) => metricValue(pair.baseline, key));
    const repoMind = pairs.map((pair) => metricValue(pair.repoMind, key));
    const deltas = repoMind.map((value, index) => value - baseline[index]!);
    const baselineMean = mean(baseline);
    const meanDelta = mean(deltas);
    const variance = deltas.length > 1 ? deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1) : 0;
    const margin = deltas.length ? 1.96 * Math.sqrt(variance / deltas.length) : 0;
    return {
      key, pairs: pairs.length, baselineMean: round(baselineMean), repoMindMean: round(mean(repoMind)),
      meanDelta: round(meanDelta), relativeDeltaPercent: baselineMean === 0 ? null : round((meanDelta / Math.abs(baselineMean)) * 100),
      confidence95: { low: round(meanDelta - margin), high: round(meanDelta + margin) },
      repoMindWins: deltas.filter((delta) => delta < 0).length,
      ties: deltas.filter((delta) => delta === 0).length,
      repoMindLosses: deltas.filter((delta) => delta > 0).length,
    };
  });
}

function summarizeProtocol(runs: AgentRunProfile[], phase: Exclude<AgentPhaseKey, "ordinary">): AgentProtocolPhaseSummary {
  const values = runs.map((run) => run.phases[phase]);
  const calls = values.reduce((sum, value) => sum + value.repoMindCalls, 0);
  const turns = values.reduce((sum, value) => sum + value.turns, 0);
  const timedCalls = values.reduce((sum, value) => sum + value.timedRepoMindCalls, 0);
  const followingTurns = values.reduce((sum, value) => sum + value.followingTurns, 0);
  const sum = (pick: (value: AgentPhaseMeasurement) => number): number => values.reduce((total, value) => total + pick(value), 0);
  return {
    calls, turns, timedCalls,
    meanDirectToolDurationMs: round(timedCalls ? sum((value) => value.directRepoMindToolDurationMs) / timedCalls : 0),
    meanToolTurnCycleDurationMs: round(turns ? sum((value) => value.toolTurnCycleDurationMs) / turns : 0),
    meanFollowingCycleDurationMs: round(followingTurns ? sum((value) => value.followingCycleDurationMs) / followingTurns : 0),
    meanToolTurnInputTokens: round(turns ? sum((value) => value.toolTurnTokens.input) / turns : 0),
    meanToolTurnOutputTokens: round(turns ? sum((value) => value.toolTurnTokens.output) / turns : 0),
    meanFollowingTurnInputTokens: round(followingTurns ? sum((value) => value.followingTurnTokens.input) / followingTurns : 0),
    meanFollowingTurnOutputTokens: round(followingTurns ? sum((value) => value.followingTurnTokens.output) / followingTurns : 0),
  };
}

export function profileAgentReport(reportPath: string, rawDirectory?: string): AgentProfileReport {
  const loaded = loadAgentReport(reportPath);
  const raw = resolve(rawDirectory ?? join(dirname(loaded.path), "raw"));
  const failures = loaded.report.integrity.passed ? [] : [`Source report integrity failed: ${loaded.path}`];
  let actualRaw: string[] = [];
  try { actualRaw = readdirSync(raw).filter((name) => name.endsWith(".jsonl")).sort(); } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read raw Agent directory ${raw}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const expected = new Set(loaded.report.runs.map(expectedRawName));
  for (const name of actualRaw) if (!expected.has(name)) failures.push(`Unexpected raw JSONL: ${name}`);
  const runs = loaded.report.runs.flatMap((run) => {
    const value = profileRun(run, raw, failures);
    return value ? [value] : [];
  });
  const arms = Object.fromEntries((["no-memory", "full-history", "repomind"] as const).flatMap((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    return selected.length ? [[arm, summarizeArm(selected)]] : [];
  }));
  const repoMindRuns = runs.filter((run) => run.arm === "repomind");
  return {
    version: 1, generatedAt: new Date().toISOString(),
    source: {
      reportPath: loaded.path, reportSha256: loaded.sha256, rawDirectory: raw,
      name: loaded.report.name, model: loaded.report.model,
      repoMindVersion: loaded.report.provenance.repoMindVersion,
      repoMindCommit: loaded.report.provenance.repoMindCommit,
    },
    integrity: { passed: failures.length === 0, failures }, runs,
    arms,
    comparisons: {
      "no-memory": comparison(runs, "no-memory"),
      "full-history": comparison(runs, "full-history"),
    },
    repoMindProtocol: {
      sessionStart: summarizeProtocol(repoMindRuns, "sessionStart"),
      sessionCommit: summarizeProtocol(repoMindRuns, "sessionCommit"),
      repoMindOther: summarizeProtocol(repoMindRuns, "repoMindOther"),
    },
  };
}

function format(value: number | null): string {
  if (value === null) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function renderAgentProfileMarkdown(report: AgentProfileReport): string {
  const armRows = (["no-memory", "full-history", "repomind"] as const).flatMap((arm) => {
    const value = report.arms[arm];
    return value ? [`| ${arm} | ${value.runs} | ${format(value.meanWallDurationMs)} | ${format(value.meanObservedDurationMs)} | ${format(value.meanUnobservedDurationMs)} | ${format(value.meanTurns)} | ${format(value.meanToolCalls)} | ${format(value.meanInputTokens)} | ${format(value.meanOutputTokens)} |`] : [];
  }).join("\n");
  const comparisonSections = (["no-memory", "full-history"] as const).flatMap((arm) => {
    const metrics = report.comparisons[arm];
    if (!metrics) return [];
    const rows = metrics.map((metric) => `| ${metric.key} | ${metric.pairs} | ${format(metric.baselineMean)} | ${format(metric.repoMindMean)} | ${format(metric.meanDelta)} | ${metric.relativeDeltaPercent === null ? "n/a" : `${format(metric.relativeDeltaPercent)}%`} | ${format(metric.confidence95.low)} to ${format(metric.confidence95.high)} |`).join("\n");
    return [`## RepoMind overhead vs ${arm}\n\n| Metric | Pairs | Baseline mean | RepoMind mean | Mean delta | Delta | 95% interval |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}`];
  }).join("\n\n");
  const phaseRows = (["sessionStart", "sessionCommit", "repoMindOther"] as const).map((phase) => {
    const value = report.repoMindProtocol[phase];
    return `| ${phase} | ${value.calls} | ${format(value.meanDirectToolDurationMs)} | ${format(value.meanToolTurnCycleDurationMs)} | ${format(value.meanFollowingCycleDurationMs)} | ${format(value.meanToolTurnInputTokens)} | ${format(value.meanToolTurnOutputTokens)} | ${format(value.meanFollowingTurnInputTokens)} | ${format(value.meanFollowingTurnOutputTokens)} |`;
  }).join("\n");
  return `# RepoMind Agent phase profile\n\nSource: \`${report.source.reportPath}\`\n\nSource SHA-256: \`${report.source.reportSha256}\`\n\nRaw events: \`${report.source.rawDirectory}\`\n\nModel: ${report.source.model}\n\nRepoMind: ${report.source.repoMindVersion} / \`${report.source.repoMindCommit ?? "unavailable"}\`\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\n## Arm-level costs\n\n| Arm | Runs | Wall ms | Observed event ms | Unobserved process ms | Turns | Tool calls | Input tokens | Output tokens |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${armRows}\n\n${comparisonSections}\n\n## RepoMind protocol phases\n\n| Phase | Calls | Direct tool ms/call | Tool-turn cycle ms | Following cycle ms | Tool-turn input | Tool-turn output | Following input | Following output |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${phaseRows}\n\nDirect tool time is measured from the tool's own start/end timestamps. Tool-turn and following-cycle values include model and orchestration time around the call. Token fields are per model turn and are not additive estimates of unique context. The paired overhead tables are the authoritative end-to-end cost.\n\n## Integrity failures\n\n${report.integrity.failures.length ? report.integrity.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}

export function writeAgentProfileReport(report: AgentProfileReport, outputDirectory: string): void {
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "profile.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(output, "profile.md"), renderAgentProfileMarkdown(report), "utf8");
}
