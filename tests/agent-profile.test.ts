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

const HOST_MANAGED_RAW = [
  line({ type: "step_start", timestamp: 1000, part: {} }),
  line({ type: "tool_use", timestamp: 1050, part: { tool: "bash", state: { status: "completed", time: { start: 1040, end: 1045 } } } }),
  line({ type: "step_finish", timestamp: 1100, part: { tokens: { input: 25, output: 3, cache: { read: 5, write: 0 } } } }),
].join("\n");

function run(arm: AgentArm, raw: string, wallDurationMs: number): AgentRunResult {
  const repoMind = arm === "repomind";
  return {
    taskId: "profile", arm, iteration: 1, repository: `/${arm}`,
    requestedCommit: "abc", baseCommit: "abc", agentExitCode: 0, agentSignal: null,
    startMs: repoMind ? null : 0, agentMs: wallDurationMs, commitMs: repoMind ? null : 0,
    maintenanceMs: repoMind ? null : 0,
    totalLifecycleMs: wallDurationMs, wallDurationMs,
    publicChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    hiddenChecks: [{ command: "node", args: [], exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, passed: true }],
    changedFiles: [], unexpectedChanges: [],
    sessionsBeforeCleanup: repoMind ? [{ id: "s1", status: "committed" }] : [],
    abandonedSessions: 0, openSessionsAfterCleanup: 0,
    lifecycle: {
      mode: repoMind ? "agent-managed" : "none", timing: repoMind ? "nested-in-agent" : "not-applicable",
      startAttempted: repoMind, startSucceeded: repoMind, sessionId: repoMind ? "s1" : null,
      retrievedMemories: repoMind ? 1 : 0, commitAttempted: repoMind, commitSucceeded: repoMind,
      commitStatus: repoMind ? "committed" : null,
      maintenanceAttempted: false, maintenanceStatus: null, evidenceCreated: 0, error: null,
    },
    contextTelemetry: repoMind
      ? { availability: "unavailable", reason: "agent-managed fixture" }
      : { availability: "not-applicable", reason: "baseline fixture" },
    maintenanceTelemetry: repoMind
      ? { availability: "unavailable", reason: "agent-managed fixture" }
      : { availability: "not-applicable", reason: "baseline fixture" },
    quality: null,
    events: analyzeAgentEvents(raw),
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

function hostManagedRun(): AgentRunResult {
  const value = run("repomind", HOST_MANAGED_RAW, 460);
  const layer = (id: string) => ({
    provided: 1, providedIds: [id], eligible: 1, eligibleIds: [id],
    injected: 1, injectedIds: [id], truncated: 0, omitted: 0,
    allocatedChars: 334, sourceChars: 100, sectionChars: 100,
  });
  return {
    ...value,
    startMs: 10,
    agentMs: 400,
    commitMs: 20,
    maintenanceMs: 30,
    totalLifecycleMs: 460,
    wallDurationMs: 460,
    lifecycle: {
      mode: "host-managed", timing: "sequential",
      startAttempted: true, startSucceeded: true, sessionId: "s1", retrievedMemories: 1,
      commitAttempted: true, commitSucceeded: true, commitStatus: "committed",
      maintenanceAttempted: true, maintenanceStatus: "success", evidenceCreated: 0, error: null,
    },
    contextTelemetry: {
      availability: "full",
      policy: { version: 1, unit: "utf16-code-units", weights: { l1: 5, l2: 3, l3: 2 } },
      retrieval: {
        maxMemories: 10, strategy: "semantic", fallbackReason: null,
        l1: [{ id: "m1", version: null, type: "decision", status: "active" }],
        l2: [{ id: "n1", version: 2, modulePath: "src", current: true }],
        l3: { id: "p1", version: 3, current: true },
      },
      context: {
        budgetChars: 1000, promptSha256: "a".repeat(64), contextChars: 300,
        promptChars: 500, unusedChars: 700,
        l1: layer("m1"), l2: layer("n1"), l3: layer("p1"),
        currentTask: { sourceChars: 20, injectedChars: 20, truncated: false },
      },
    },
    maintenanceTelemetry: {
      availability: "full", attempted: true, trigger: "committed-session", reason: null,
      report: {
        status: "success", durationMs: 30,
        before: { l2: [], l3: null, l4: [] }, after: { l2: [], l3: null, l4: [] }, telemetryErrors: [],
        l2: { status: "skipped", durationMs: 0, result: null, error: null, reason: "fixture" },
        l3: { status: "skipped", durationMs: 0, result: null, error: null, reason: "fixture" },
        l4: { status: "skipped", durationMs: 0, result: null, error: null, reason: "fixture" },
      },
    },
    quality: {
      completion: "clean", status: "success", maintenanceEligible: true, qualityFlags: [],
      commands: { observed: 0, failed: 0, recovered: 0, unrecovered: 0 },
      authoritativeVerification: { authority: "benchmark-manifest", checks: 2, passed: true, snapshotStable: true },
      trace: { malformedLines: 0, explicitErrors: 0, unknownCommandResults: 0, terminal: "clean-stop" },
    },
  };
}

function hostFixture(root: string): string {
  const raw = join(root, "raw");
  mkdirSync(raw);
  writeFileSync(join(raw, "profile-no-memory-1.jsonl"), NO_MEMORY_RAW, "utf8");
  writeFileSync(join(raw, "profile-repomind-1.jsonl"), HOST_MANAGED_RAW, "utf8");
  const report = buildAgentReport({
    name: "host profile fixture", runner: "opencode", model: "test", repeat: 1,
    repoMindLifecycle: "host-managed", outputDirectory: root,
    provenance: {
      repoMindVersion: "test", repoMindCommit: "abc", repoMindDirty: false, node: process.version,
      os: { platform: process.platform, release: "test", arch: process.arch }, runnerVersion: "test",
      manifestSha256: "0".repeat(64), taskBaseCommits: { profile: "abc" },
    },
    runs: [run("no-memory", NO_MEMORY_RAW, 400), hostManagedRun()],
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
      expect(JSON.parse(readFileSync(join(output, "profile.json"), "utf8"))).toMatchObject({ version: 2 });
      expect(readFileSync(join(output, "profile.md"), "utf8")).toContain("RepoMind protocol phases");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("profiles Host-managed lifecycle, layered context, and telemetry coverage", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-host-profile-"));
    try {
      const report = profileAgentReport(hostFixture(root));
      expect(report.source).toMatchObject({ schemaVersion: 7, repoMindLifecycle: "host-managed" });
      expect(report.hostManaged).toMatchObject({
        runCount: 1,
        meanStartMs: 10,
        meanAgentMs: 400,
        meanCommitMs: 20,
        meanMaintenanceMs: 30,
        meanTotalLifecycleMs: 460,
        meanContextChars: 300,
        meanBudgetChars: 1000,
        meanInjected: { l1: 1, l2: 1, l3: 1 },
        telemetryCoverage: {
          context: { total: 1, full: 1, unavailable: 0, notApplicable: 0, missing: 0 },
          quality: { total: 1, full: 1, unavailable: 0, notApplicable: 0, missing: 0 },
          maintenance: { total: 1, full: 1, unavailable: 0, notApplicable: 0, missing: 0 },
        },
      });
      expect(report.hostManaged.runs[0]).toMatchObject({
        lifecycle: { start: "success", commit: "committed", maintenance: "success" },
        context: {
          l1: { provided: 1, eligible: 1, injected: 1 },
          l2: { provided: 1, eligible: 1, injected: 1 },
          l3: { provided: 1, eligible: 1, injected: 1 },
          contextChars: 300, budgetChars: 1000,
        },
        quality: { availability: "full", completion: "clean", status: "success" },
        maintenance: { availability: "full", attempted: true, status: "success" },
      });
      expect(report.repoMindProtocol.sessionStart.calls).toBe(0);
      const markdown = renderAgentProfileMarkdown(report);
      expect(markdown).toContain("Host-managed lifecycle");
      expect(markdown).toContain("Host telemetry coverage");
      expect(markdown).toContain("| profile | repomind-1 | success (10 ms) | 400 | committed (20 ms) | success (30 ms)");
      expect(markdown).toContain("Host-managed start, commit, and maintenance are measured separately above");
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
