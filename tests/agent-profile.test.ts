import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAgentEvents, parseAgentEvents } from "../src/eval/agent/events.js";
import { profileAgentReport, renderAgentProfileMarkdown, writeAgentProfileReport } from "../src/eval/agent/profile.js";
import { buildAgentReport, type AgentArm, type AgentRunResult } from "../src/eval/agent/report.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

const NO_MEMORY_RAW = [
  line({ type: "step_start", timestamp: 1000, part: {} }),
  line({ type: "tool_use", timestamp: 1050, part: { tool: "bash", state: { status: "completed", time: { start: 1040, end: 1045 } } } }),
  line({ type: "step_finish", timestamp: 1100, part: { tokens: { input: 40, output: 4, cache: { read: 10, write: 0 } } } }),
  line({ type: "step_start", timestamp: 1200, part: {} }),
  line({ type: "step_finish", timestamp: 1300, part: { tokens: { input: 50, output: 5, cache: { read: 20, write: 0 } } } }),
].join("\n");

const FULL_HISTORY_RAW = [
  line({ type: "step_start", timestamp: 1000, part: {} }),
  line({ type: "tool_use", timestamp: 1050, part: { tool: "bash", state: { status: "completed", time: { start: 1040, end: 1045 } } } }),
  line({ type: "step_finish", timestamp: 1100, part: { tokens: { input: 30, output: 3, cache: { read: 10, write: 0 } } } }),
  line({ type: "step_start", timestamp: 1200, part: {} }),
  line({ type: "step_finish", timestamp: 1300, part: { tokens: { input: 40, output: 4, cache: { read: 20, write: 0 } } } }),
].join("\n");

const REPOMIND_RAW = [
  line({ type: "step_start", timestamp: 1000, part: {} }),
  line({ type: "tool_use", timestamp: 1150, part: { tool: "repomind_repo_session_start", state: { status: "completed", time: { start: 1100, end: 1150 }, output: line({ memories: [{ id: "m1" }] }) } } }),
  line({ type: "step_finish", timestamp: 1200, part: { tokens: { input: 20, output: 2, cache: { read: 10, write: 0 } } } }),
  line({ type: "step_start", timestamp: 1300, part: {} }),
  line({ type: "tool_use", timestamp: 1400, part: { tool: "read", state: { status: "completed", time: { start: 1380, end: 1390 }, input: { filePath: "README.md" } } } }),
  line({ type: "step_finish", timestamp: 1500, part: { tokens: { input: 30, output: 3, cache: { read: 20, write: 0 } } } }),
  line({ type: "step_start", timestamp: 1600, part: {} }),
  line({ type: "tool_use", timestamp: 1800, part: { tool: "repomind_repo_session_commit", state: { status: "completed", time: { start: 1700, end: 1800 } } } }),
  line({ type: "step_finish", timestamp: 1900, part: { tokens: { input: 40, output: 4, cache: { read: 30, write: 0 } } } }),
  line({ type: "step_start", timestamp: 2000, part: {} }),
  line({ type: "step_finish", timestamp: 2200, part: { tokens: { input: 50, output: 5, cache: { read: 40, write: 0 } } } }),
].join("\n");

function run(arm: AgentArm, raw: string, wallDurationMs: number): AgentRunResult {
  return {
    taskId: "profile", arm, iteration: 1, repository: `/${arm}`,
    requestedCommit: "abc", baseCommit: "abc", agentExitCode: 0, agentSignal: null,
    wallDurationMs,
    publicChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    hiddenChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    changedFiles: [], unexpectedChanges: [],
    sessionsBeforeCleanup: arm === "repomind" ? [{ id: "s1", status: "committed" }] : [],
    abandonedSessions: 0, openSessionsAfterCleanup: 0, events: analyzeAgentEvents(raw),
  };
}

function fixture(root: string): string {
  const raw = join(root, "raw");
  mkdirSync(raw);
  const values: Array<[AgentArm, string, number]> = [
    ["no-memory", NO_MEMORY_RAW, 400],
    ["full-history", FULL_HISTORY_RAW, 350],
    ["repomind", REPOMIND_RAW, 1400],
  ];
  for (const [arm, content] of values) writeFileSync(join(raw, `profile-${arm}-1.jsonl`), content, "utf8");
  const report = buildAgentReport({
    name: "profile fixture", runner: "opencode", model: "test", repeat: 1, outputDirectory: root,
    provenance: {
      repoMindVersion: "test", repoMindCommit: "abc", repoMindDirty: false, node: process.version,
      os: { platform: process.platform, release: "test", arch: process.arch }, runnerVersion: "test",
      manifestSha256: "0".repeat(64), taskBaseCommits: { profile: "abc" },
    },
    runs: values.map(([arm, content, wall]) => run(arm, content, wall)),
  });
  const path = join(root, "summary.json");
  writeFileSync(path, `${JSON.stringify(report)}\n`, "utf8");
  return path;
}

describe("Agent phase profiling", () => {
  it("profiles direct MCP time, surrounding cycles, and paired token overhead", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-profile-"));
    try {
      const report = profileAgentReport(fixture(root));
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      expect(report.arms.repomind).toMatchObject({ runs: 1, meanTurns: 4, meanInputTokens: 140, meanOutputTokens: 14 });
      expect(report.repoMindProtocol.sessionStart).toMatchObject({
        calls: 1, timedCalls: 1, meanDirectToolDurationMs: 50,
        meanToolTurnCycleDurationMs: 200, meanFollowingCycleDurationMs: 300,
        meanToolTurnInputTokens: 20, meanFollowingTurnInputTokens: 30,
      });
      expect(report.repoMindProtocol.sessionCommit).toMatchObject({
        calls: 1, timedCalls: 1, meanDirectToolDurationMs: 100,
        meanToolTurnCycleDurationMs: 400, meanFollowingCycleDurationMs: 300,
        meanToolTurnOutputTokens: 4, meanFollowingTurnOutputTokens: 5,
      });
      expect(report.comparisons["full-history"]?.find((metric) => metric.key === "inputTokens")).toMatchObject({
        baselineMean: 70, repoMindMean: 140, meanDelta: 70, relativeDeltaPercent: 100,
      });
      const markdown = renderAgentProfileMarkdown(report);
      expect(markdown).toContain("Direct tool time is measured");
      const output = join(root, "profile-output");
      writeAgentProfileReport(report, output);
      expect(JSON.parse(readFileSync(join(output, "profile.json"), "utf8"))).toMatchObject({ version: 1 });
      expect(readFileSync(join(output, "profile.md"), "utf8")).toContain("RepoMind protocol phases");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports malformed, missing, and unexpected raw artifacts as integrity failures", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-profile-invalid-"));
    try {
      const path = fixture(root);
      writeFileSync(join(root, "raw", "profile-repomind-1.jsonl"), `${REPOMIND_RAW}\nnot-json\n`, "utf8");
      rmSync(join(root, "raw", "profile-full-history-1.jsonl"));
      writeFileSync(join(root, "raw", "unexpected.jsonl"), "{}\n", "utf8");
      const report = profileAgentReport(path);
      expect(report.integrity.passed).toBe(false);
      expect(report.integrity.failures).toEqual(expect.arrayContaining([
        expect.stringContaining("Unexpected raw JSONL"),
        expect.stringContaining("unable to read raw JSONL"),
        expect.stringContaining("malformed raw event line"),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("counts malformed JSONL lines without changing valid event parsing", () => {
    const parsed = parseAgentEvents(`${NO_MEMORY_RAW}\nnot-json\n[]\n`);
    expect(parsed.malformedLines).toBe(2);
    expect(parsed.events.length).toBe(5);
  });
});
