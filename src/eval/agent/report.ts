import type { AgentEventMetrics } from "./events.js";

export type AgentArm = "no-memory" | "repomind";

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

export interface AgentEvalReport {
  version: 1;
  name: string;
  generatedAt: string;
  runner: "opencode";
  model: string;
  repeat: number;
  outputDirectory: string;
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
  integrity: { passed: boolean; failures: string[] };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildAgentReport(input: Omit<AgentEvalReport, "version" | "generatedAt" | "arms" | "integrity">): AgentEvalReport {
  const arms = Object.fromEntries((["no-memory", "repomind"] as const).map((arm) => {
    const runs = input.runs.filter((run) => run.arm === arm);
    return [arm, {
      runs: runs.length,
      agentCleanExits: runs.filter((run) => run.agentExitCode === 0).length,
      publicPasses: runs.filter((run) => run.publicChecks.every((check) => check.passed)).length,
      hiddenPasses: runs.filter((run) => run.hiddenChecks.every((check) => check.passed)).length,
      meanWallDurationMs: round(mean(runs.map((run) => run.wallDurationMs))),
      meanInputTokens: round(mean(runs.map((run) => run.events.tokens.input))),
      meanOutputTokens: round(mean(runs.map((run) => run.events.tokens.output))),
      meanFileReads: round(mean(runs.map((run) => run.events.fileReads))),
      repoMindCalls: runs.reduce((sum, run) => sum + run.events.repoMindCalls, 0),
      retrievedMemories: runs.reduce((sum, run) => sum + run.events.retrievedMemories, 0),
    }];
  })) as AgentEvalReport["arms"];

  const failures: string[] = [];
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
  return { version: 1, generatedAt: new Date().toISOString(), ...input, arms, integrity: { passed: failures.length === 0, failures } };
}

export function renderAgentMarkdown(report: AgentEvalReport): string {
  const rows = (["no-memory", "repomind"] as const).map((arm) => {
    const value = report.arms[arm];
    return `| ${arm} | ${value.hiddenPasses}/${value.runs} | ${value.publicPasses}/${value.runs} | ${(value.meanWallDurationMs / 1000).toFixed(1)} s | ${Math.round(value.meanInputTokens)} | ${Math.round(value.meanOutputTokens)} | ${value.meanFileReads.toFixed(1)} |`;
  }).join("\n");
  const runs = report.runs.map((run) =>
    `| ${run.taskId} | ${run.arm}-${run.iteration} | ${run.hiddenChecks.every((check) => check.passed) ? "pass" : "fail"} | ${run.publicChecks.every((check) => check.passed) ? "pass" : "fail"} | ${(run.wallDurationMs / 1000).toFixed(1)} s | ${run.events.tokens.input} | ${run.events.fileReads} | ${run.events.repoMindCalls} |`,
  ).join("\n");
  return `# RepoMind agent A/B benchmark\n\nManifest: ${report.name}\n\nRunner: ${report.runner} / ${report.model}\n\nRepeat: ${report.repeat}\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\n| Arm | Hidden checks | Public checks | Mean wall time | Mean input tokens | Mean output tokens | Mean file reads |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n## Runs\n\n| Task | Run | Hidden | Public | Wall time | Input tokens | File reads | RepoMind calls |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: |\n${runs}\n\n## Integrity failures\n\n${report.integrity.failures.length ? report.integrity.failures.map((failure) => `- ${failure}`).join("\n") : "None."}\n`;
}
