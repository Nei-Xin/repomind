import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import { createOpenCodeHostAdapter } from "../src/integrations/opencode/adapter.js";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import type { AgentProcessExecutor } from "../src/integrations/agent-host/types.js";
import { createTestRepository, git } from "./helpers.js";

const summary = "Storage tests passed. 发票金额已改为单价乘以数量，src/invoice 模块负责金额计算。";

describe("automatic Host solution eligibility", () => {
  let repository: string, dataDirectory: string, core: RepositoryMemoryCore;
  beforeEach(() => {
    repository = createTestRepository();
    dataDirectory = mkdtempSync(join(tmpdir(), "repomind-host-policy-"));
    vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
    initializeRepository(repository).database.close();
    core = new RepositoryMemoryCore(repository, { dataDirectory });
  });
  afterEach(() => {
    core.close();
    vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  const scenarios = [
    { name: "read-only query", command: "git status --short", eligible: false },
    { name: "summary-only test claim", eligible: false },
    { name: "unchanged pre-existing edits", dirty: true, eligible: false },
    { name: "new file", change: "create", eligible: true },
    { name: "deletion only", change: "delete", eligible: true },
    { name: "edit to a previously dirty file", dirty: true, change: "edit", eligible: true },
    { name: "self-committed change", change: "commit", eligible: true },
    { name: "observed passing test", command: "npm test", eligible: true },
    { name: "masked test exit", command: "npm test || true", eligible: false },
    { name: "successful build only", command: "npm run build", eligible: false },
    { name: "public Host verification", verification: "public", eligible: true },
    { name: "hidden check alone", verification: "hidden", eligible: false },
    { name: "unknown test exit", command: "npm test", unknown: true, eligible: false },
  ];

  describe.each(["opencode", "claude"] as const)("%s", (runner) => {
    it.each(scenarios)("$name", async (scenario) => {
      if (scenario.dirty) writeFileSync(join(repository, "README.txt"), "pre-existing edit\n");
      const execute: AgentProcessExecutor = async () => {
        if (scenario.change === "delete") rmSync(join(repository, "README.txt"));
        if (scenario.change === "edit") writeFileSync(join(repository, "README.txt"), "task edit\n");
        if (scenario.change === "create" || scenario.change === "commit") writeFileSync(join(repository, "outcome.txt"), "task result\n");
        if (scenario.change === "commit") {
          git(repository, "add", "outcome.txt");
          git(repository, "commit", "-m", "task change");
        }
        const events: unknown[] = [];
        if (runner === "opencode") {
          if (scenario.command) events.push({ type: "tool_use", part: { tool: "bash", state: {
            status: "completed", input: { command: scenario.command }, output: "observed output",
            metadata: scenario.unknown ? {} : { exit: 0 },
          } } });
          events.push({ type: "text", part: { text: summary } }, { type: "step_finish", part: { reason: "stop" } });
        } else {
          if (scenario.command) {
            events.push({ type: "assistant", message: { role: "assistant", content: [
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: scenario.command } },
            ] } });
            if (!scenario.unknown) events.push({ type: "user", message: { role: "user", content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "observed output", is_error: false },
            ] } });
          }
          events.push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: summary });
        }
        return { exitCode: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", durationMs: 1,
          timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false };
      };
      const check = { command: "custom repository verification", exitCode: 0, summary: "verified by Host" };
      const report = await runAgentHost({ repository, dataDirectory, outputDirectory: join(dataDirectory, "run"),
        task: "How is storage verified?", adapter: runner === "opencode" ? createOpenCodeHostAdapter({ execute }) : createClaudeHostAdapter({ execute }),
        ...(scenario.verification ? { verify: () => ({ checks: [check], evidence: scenario.verification === "public" ? [check] : [] }) } : {}),
      });
      expect(report.session.status).toBe(scenario.unknown ? "partial" : "committed");
      const solutions = core.context.database.raw.prepare("SELECT id FROM memories WHERE type='solution'").all();
      expect(solutions).toHaveLength(scenario.eligible ? 1 : 0);
      if (!scenario.eligible) expect(core.context.database.raw.prepare("SELECT id FROM memories WHERE type IN ('decision','architecture')").all()).toEqual([]);
      const evidence = core.context.database.raw.prepare("SELECT content FROM evidence WHERE session_id=? AND kind='agent_summary'").get(report.session.id);
      expect(evidence).toEqual({ content: summary });
      expect(core.inspectHostRun(report.runId)).toMatchObject({ status: report.session.status });
      expect(core.status()).toMatchObject({ openSessions: 0, runningHostRuns: 0 });
      if (scenario.command) {
        const rows = core.context.database.raw.prepare("SELECT metadata_json FROM evidence WHERE session_id=? AND kind='command_result'").all(report.session.id) as Array<{ metadata_json: string }>;
        expect(rows).toHaveLength(scenario.unknown ? 0 : 1);
        if (!scenario.unknown) expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ verificationSource: "tool-observed", command: scenario.command });
      }
    });
  });

  it.each(["caller-reported", "tool-observed", "host-verified"] as const)("uses command provenance for the shared Core gate: %s", (source) => {
    const session = core.startSession({ task: "Check storage" });
    const input = { sessionId: session.sessionId, idempotencyKey: "policy", status: "success" as const, summary,
      commands: [{ command: "node --test", exitCode: 0, summary: "passed" }] };
    const result = core.commitSession(input, { commands: source, solutionPolicy: "repository-outcome" });
    expect(core.commitSession(input, { commands: source, solutionPolicy: "repository-outcome" })).toEqual(result);
    expect(core.context.database.raw.prepare("SELECT id FROM memories WHERE type='solution'").all()).toHaveLength(source === "caller-reported" ? 0 : 1);
    expect(() => core.commitSession(input, { commands: source })).toThrow(/Idempotency/);
  });
});
