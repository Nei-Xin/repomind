import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessCommandVerification } from "../src/activity/test-command.js";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { assessAgentOutcome } from "../src/integrations/agent-host/outcome.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import { createOpenCodeHostAdapter } from "../src/integrations/opencode/adapter.js";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import { createTestRepository } from "./helpers.js";

type Command = { command: string; exitCode: number | null };
const cmd = (command: string, exitCode: number | null): Command => ({ command, exitCode });
const normalize = (commands: Command[]) => commands.map(c => ({ ...c, exitCode: c.exitCode ?? 1, exitCodeKnown: c.exitCode !== null, isTest: false, summary: "observed" }));
const assess = (commands: Command[]) => assessAgentOutcome({ agentExitCode: 0, commands: normalize(commands) });
const cases: Array<{ name: string; commands: Command[]; status: "success" | "partial" }> = [
  { name: "failed exploration", commands: [cmd("ls missing", 1), cmd("cat missing", 1), cmd("rg absent README.txt", 1)], status: "success" },
  { name: "unknown exploration", commands: [cmd("git status", null)], status: "success" },
  { name: "unresolved test", commands: [cmd("npm test", 1)], status: "partial" },
  { name: "test recovered", commands: [cmd("npm test", 1), cmd("npm test", 0)], status: "success" },
  { name: "test regressed", commands: [cmd("npm test", 0), cmd("npm test", 1)], status: "partial" },
  { name: "build recovered", commands: [cmd("npm run build", 1), cmd("npm run build", 0)], status: "success" },
  { name: "unknown test recovered", commands: [cmd("npm test", null), cmd("npm test", 0)], status: "success" },
  { name: "unknown test unresolved", commands: [cmd("npm test", null)], status: "partial" },
  { name: "masked pass", commands: [cmd("npm test || true", 0)], status: "partial" },
  { name: "piped pass", commands: [cmd("npm test | tail", 0)], status: "partial" },
  { name: "unrelated pass", commands: [cmd("npm test -- storage", 1), cmd("npm test -- billing", 0)], status: "partial" },
  { name: "different directory", commands: [cmd("cd a && npm test", 1), cmd("cd b && npm test", 0)], status: "partial" },
  { name: "different environment", commands: [cmd("NODE_ENV=a npm test", 1), cmd("NODE_ENV=b npm test", 0)], status: "partial" },
  { name: "incomplete chain recovery", commands: [cmd("npm run build && npm test", 1), cmd("npm test", 0)], status: "partial" },
  { name: "complete chain recovery", commands: [cmd("npm run build && npm test", 1), cmd("npm run build", 0), cmd("npm test", 0)], status: "success" },
  { name: "output redirection recovery", commands: [cmd("node --test > old.log", 1), cmd("node --test > new.log", 0)], status: "success" },
  { name: "masked failure followed by real pass", commands: [cmd("npm test || true", 0), cmd("npm test", 0)], status: "success" },
  { name: "test argument in exploration", commands: [cmd("grep test README.txt", 1)], status: "success" },
];

describe("shared verification outcome", () => {
  it.each(cases)("$name", ({ commands, status }) => {
    expect(assess(commands).status).toBe(status);
    expect(assessCommandVerification(commands).unresolved > 0).toBe(status === "partial");
  });
  it("keeps exploration failure counts separate from recovered verification", () => {
    expect(assess([cmd("ls missing", 1), cmd("npm test", 1), cmd("npm test", 0)])).toMatchObject({
      completion: "recovered", status: "success", commands: { observed: 3, failed: 2, recovered: 1, unrecovered: 0, nonVerificationFailures: 1 },
      verification: { steps: 1, unresolved: 0 }, qualityFlags: ["recovered-command-failure"],
    });
  });
  it.each([
    { stdoutTruncated: true },
    { repoMindCalls: 1 },
    { trace: { parsedEvents: 3, malformedLines: 1, explicitErrors: 0, unknownCommandResults: 0, terminal: "clean-stop" as const } },
    { trace: { parsedEvents: 3, malformedLines: 0, explicitErrors: 0, unknownCommandResults: 0, terminal: "incomplete" as const } },
    { trace: { parsedEvents: 3, malformedLines: 0, explicitErrors: 0, unknownCommandResults: 1, terminal: "clean-stop" as const } },
    { authoritativeChecks: [{ exitCode: null }], verificationSnapshotStable: true },
    { authoritativeChecks: [{ exitCode: 0 }], verificationSnapshotStable: false },
  ])("does not let a rerun bypass independent Host integrity gates: %j", (override) => {
    expect(assessAgentOutcome({ agentExitCode: 0, commands: normalize([cmd("npm test", 1), cmd("npm test", 0)]), ...override }).status).toBe("partial");
  });
  it("keeps authoritative failure and provider failure terminal", () => {
    const commands = normalize([cmd("npm test", 1), cmd("npm test", 0)]);
    expect(assessAgentOutcome({ agentExitCode: 0, commands, authoritativeChecks: [{ exitCode: 1 }], verificationSnapshotStable: true }).status).toBe("failed");
    expect(assessAgentOutcome({ agentExitCode: 1, commands }).status).toBe("failed");
  });
});

describe("automatic lifecycle status parity", () => {
  let repository: string, dataDirectory: string, core: RepositoryMemoryCore;
  beforeEach(() => {
    repository = createTestRepository();
    dataDirectory = mkdtempSync(join(tmpdir(), "repomind-status-parity-"));
    vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
    initializeRepository(repository).database.close();
    core = new RepositoryMemoryCore(repository, { dataDirectory });
  });
  afterEach(() => {
    core.close();vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true });rmSync(dataDirectory, { recursive: true, force: true });
  });
  describe.each(["interactive", "opencode", "claude"] as const)("%s", runner => {
    it.each(cases.filter(c => ["failed exploration", "unknown exploration", "test recovered", "unknown test recovered", "masked pass", "incomplete chain recovery"].includes(c.name)))("$name", async ({ commands, status }) => {
      let sessionId: string;
      const mutate = () => writeFileSync(join(repository, "result.txt"), "actual task change\n");
      if (runner === "interactive") {
        const store = new InteractiveActivityStore(repository, dataDirectory);
        try {
          const common = { schemaVersion: 1, agent: "claude", agentSessionId: "status-case", repositoryPath: repository } as const;
          sessionId = store.startTask({ ...common, eventId: "start", task: "Verify repository" }).sessionId;
          for (const [i,c] of commands.entries()) store.record({ ...common, eventId: `command-${i}`, source: "claude-hook", type: "tool_result", timestamp: Date.now()+i,
            payload: { toolName: "Bash", toolInput: { command: c.command }, observedExitCode: c.exitCode, toolResponse: "observed" } });
          mutate();
          store.finish({ ...common, eventId: "finish", summary: "Completed the task." });
        } finally { store.close(); }
      } else {
        const execute = async () => {
          mutate();const events: unknown[] = [];
          for (const [i,c] of commands.entries()) {
            if (runner === "opencode") events.push({ type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: c.command }, output: "observed", metadata: c.exitCode === null ? {} : { exit: c.exitCode } } } });
            else {
              events.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${i}`, name: "Bash", input: { command: c.command } }] } });
              if (c.exitCode !== null) events.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: "observed", is_error: c.exitCode !== 0 }] }, tool_use_result: { exitCode: c.exitCode } });
            }
          }
          if (runner === "opencode") events.push({ type: "text", part: { text: "Completed the task." } }, { type: "step_finish", part: { reason: "stop" } });
          else events.push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "Completed the task." });
          return { exitCode: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", durationMs: 1, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false };
        };
        const report = await runAgentHost({ repository, dataDirectory, outputDirectory: join(dataDirectory, "run"), task: "Verify repository",
          adapter: runner === "opencode" ? createOpenCodeHostAdapter({ execute }) : createClaudeHostAdapter({ execute }) });
        sessionId = report.session.id;
        expect(report.quality.status).toBe(status);
        expect(report.attempts).toHaveLength(1);
        expect(report.attempts[0]!.outcome.commands).toHaveLength(commands.length);
      }
      expect(core.context.database.raw.prepare("SELECT status FROM sessions WHERE id=?").get(sessionId)).toEqual({ status: status === "success" ? "committed" : "partial" });
      expect(core.context.database.raw.prepare("SELECT id FROM memories WHERE type='solution'").all()).toHaveLength(status === "success" ? 1 : 0);
      const rows = core.context.database.raw.prepare("SELECT metadata_json FROM evidence WHERE session_id=? AND kind IN ('test_result','command_result') ORDER BY created_at,id").all(sessionId) as Array<{ metadata_json: string }>;
      expect(rows).toHaveLength(commands.filter(c=>c.exitCode!==null).length);
      expect(rows.map(r=>JSON.parse(r.metadata_json).exitCode).sort()).toEqual(commands.filter(c=>c.exitCode!==null).map(c=>c.exitCode).sort());
      expect(core.status()).toMatchObject({ openSessions: 0, runningHostRuns: 0 });
    });
  });
});
