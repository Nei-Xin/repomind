import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { RepositoryMemoryCore } from "../src/core.js";
import type { CommandEvidenceSource } from "../src/domain/types.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import type { AgentProcessExecutor } from "../src/integrations/agent-host/types.js";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import { createOpenCodeHostAdapter } from "../src/integrations/opencode/adapter.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const command = "node --test storage.test.mjs";

describe("command memory lifecycle across sessions and collectors", () => {
  let repository: string, dataDirectory: string, core: RepositoryMemoryCore;
  let run = 0;
  beforeEach(() => {
    repository = createTestRepository();
    dataDirectory = mkdtempSync(join(tmpdir(), "repomind-command-lifecycle-"));
    vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
    initializeRepository(repository).database.close();
    core = new RepositoryMemoryCore(repository, { dataDirectory });
    run = 0;
  });
  afterEach(() => {
    core.close();
    vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  function reopen() {
    core.close();
    core = new RepositoryMemoryCore(repository, { dataDirectory });
  }
  function commands() {
    return core.context.database.raw.prepare("SELECT id, title, content, status, last_validated_at FROM memories WHERE type='command' ORDER BY created_at, id")
      .all() as Array<{ id: string; title: string; content: string; status: string; last_validated_at: number }>;
  }
  function evidence(memoryId: string) {
    return core.context.database.raw.prepare(`
      SELECT e.id, e.session_id, e.kind, e.content, e.metadata_json FROM memory_evidence me
      JOIN evidence e ON e.id=me.evidence_id WHERE me.memory_id=? ORDER BY e.created_at, e.id
    `).all(memoryId) as Array<{ id: string; session_id: string; kind: string; content: string; metadata_json: string }>;
  }
  function commit(kind: "tests" | "commands", output: string, source: CommandEvidenceSource = "tool-observed", cmd = command) {
    const session = core.startSession({ task: "Verify storage tests" });
    const input = { sessionId: session.sessionId, idempotencyKey: "result", status: "success" as const,
      summary: "Storage verification completed.", [kind]: [{ command: cmd, exitCode: 0, summary: output }] };
    const sources = { [kind]: source, solutionPolicy: "repository-outcome" as const };
    const result = core.commitSession(input, sources);
    expect(core.commitSession(input, sources)).toEqual(result);
    return result;
  }
  async function host(runner: "opencode" | "claude", cmd?: string, options: {
    mutate?: () => void; budget?: number; verify?: boolean;
  } = {}) {
    let prompt = "";
    const execute: AgentProcessExecutor = async (request) => {
      prompt = request.args.at(-1)!;
      options.mutate?.();
      const events: unknown[] = [];
      if (runner === "opencode") {
        if (cmd) events.push({ type: "tool_use", part: { tool: "bash", state: {
          status: "completed", input: { command: cmd }, output: "3 tests passed", metadata: { exit: 0 },
        } } });
        events.push({ type: "text", part: { text: "Storage verification completed." } }, { type: "step_finish", part: { reason: "stop" } });
      } else {
        if (cmd) {
          events.push({ type: "assistant", message: { role: "assistant", content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: cmd } },
          ] } });
          events.push({ type: "user", message: { role: "user", content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "3 tests passed", is_error: false },
          ] } });
        }
        events.push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "Storage verification completed." });
      }
      return { exitCode: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", durationMs: 1,
        timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false };
    };
    const check = { command, exitCode: 0, summary: "Host confirmed storage tests" };
    const report = await runAgentHost({ repository, dataDirectory, outputDirectory: join(dataDirectory, `run-${++run}`),
      task: "Verify storage tests", maxMemories: 10, ...(options.budget ? { contextBudgetChars: options.budget } : {}),
      adapter: runner === "opencode" ? createOpenCodeHostAdapter({ execute }) : createClaudeHostAdapter({ execute }),
      ...(options.verify ? { verify: () => ({ checks: [check], evidence: [check] }) } : {}),
    });
    expect(report.session.status).toBe("committed");
    return { report, prompt };
  }

  it.each(["opencode", "claude"] as const)("%s tool tests retain one identity through interactive and Host reruns", async (runner) => {
    const first = await host(runner, command, { mutate: () => writeFileSync(join(repository, "storage.js"), "export const version = 1;\n") });
    expect(commands()).toHaveLength(1);
    const original = commands()[0]!;
    expect(core.inspect(original.id)).toMatchObject({ title: `Verified command: ${command}`, confidence: 0.9 });
    expect(evidence(original.id)).toEqual([expect.objectContaining({ kind: "command_result", session_id: first.report.session.id })]);
    const firstEvidence = evidence(original.id)[0]!;
    expect(JSON.parse(firstEvidence.metadata_json)).toMatchObject({ verificationSource: "tool-observed" });

    // Another process edits a dependency; a new collector must observe staleness.
    reopen();
    writeFileSync(join(repository, "storage.js"), "export const version = 2;\n");
    expect(core.inspect(original.id).status).toBe("uncertain");
    const store = new InteractiveActivityStore(repository, dataDirectory);
    try {
      const common = { schemaVersion: 1, agent: "opencode", agentSessionId: "interactive-rerun", repositoryPath: repository } as const;
      store.startTask({ ...common, eventId: "start", task: "Verify storage tests" });
      store.record({ ...common, eventId: "tool", source: "opencode-plugin", type: "tool_result", payload: {
        toolName: "bash", toolInput: { command: `ls && ${command} 2>&1` }, toolResponse: { exitCode: 0, output: "4 tests passed" },
      } });
      store.finish({ ...common, eventId: "finish", summary: "Storage tests passed again." });
    } finally { store.close(); }
    reopen();
    expect(commands()).toEqual([expect.objectContaining({ id: original.id, status: "active", content: original.content })]);
    expect(commands()[0]!.last_validated_at).toBeGreaterThan(original.last_validated_at);
    expect(evidence(original.id)).toHaveLength(2);
    expect(evidence(original.id)).toContainEqual(firstEvidence);

    const third = await host(runner, `cd . && ${command} 2>&1`);
    expect(third.report.commit?.memories.revalidated).toBe(1);
    expect(commands()).toHaveLength(1);
    expect(evidence(original.id)).toHaveLength(3);
    const latest = evidence(original.id).find((entry) => entry.session_id === third.report.session.id)!;
    expect(JSON.parse(latest.content).command).toBe(`cd . && ${command} 2>&1`);
    expect(core.inspect(original.id).status).toBe("active");
    expect(core.context.database.raw.prepare("SELECT action FROM memory_audit_log WHERE memory_id=? AND action='memory_revalidated'").all(original.id)).toHaveLength(2);

    // Inspect the real adapter input, persisted report, and SQLite audit after reopen.
    reopen();
    const next = await host(runner);
    expect(next.prompt).toContain(original.id);
    expect(next.prompt).toContain(`Verified command: ${command}`);
    expect(next.prompt).not.toContain("Unverified command");
    expect(next.report.context.l1.injectedIds).toContain(original.id);
    expect(next.report.context.promptChars).toBe(next.prompt.length);
    expect(next.report.context.promptSha256).toBe(createHash("sha256").update(next.prompt).digest("hex"));
    expect(core.inspectHostRun(next.report.runId).metadata.context).toEqual(next.report.context);
    expect(JSON.parse(readFileSync(next.report.artifacts.report, "utf8")).context).toEqual(next.report.context);
    expect(evidence(original.id)).toHaveLength(3);
    expect(core.status()).toMatchObject({ openSessions: 0, runningHostRuns: 0 });
  });

  describe.each(["tests", "commands"] as const)("%s", (kind) => {
    it.each(["invalid", "superseded"] as const)("does not recreate a %s command when output changes", (status) => {
      commit(kind, "3 tests passed");
      expect(commands()).toHaveLength(1);
      const original = commands()[0]!;
      if (status === "invalid") core.invalidateMemory({ memoryId: original.id, reason: "Obsolete test entrypoint" });
      else core.correctMemory({ memoryId: original.id, title: "Use the new storage test entrypoint", content: "Run node --test new-storage.test.mjs instead.", reason: "Old entrypoint was replaced" });
      const before = evidence(original.id);
      reopen();
      const result = commit(kind, "4 tests passed with new timing information");
      expect(result.memories.revalidated).toBe(0);
      expect(commands().filter((entry) => entry.title === original.title)).toEqual([expect.objectContaining({ id: original.id, status })]);
      expect(evidence(original.id)).toEqual(before);
      expect(core.context.database.raw.prepare("SELECT id FROM evidence WHERE session_id=? AND kind=?").all(result.sessionId, kind === "tests" ? "test_result" : "command_result")).toHaveLength(1);
      expect(core.search(command, { types: ["command"] }).map((memory) => memory.id)).not.toContain(original.id);
    });
  });

  it("links public Host and tool evidence to one command without rewriting either source", async () => {
    const result = await host("opencode", `ls && ${command} 2>&1`, { verify: true });
    expect(commands()).toHaveLength(1);
    const entries = evidence(commands()[0]!.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.kind, JSON.parse(entry.metadata_json).verificationSource])).toEqual(expect.arrayContaining([
      ["test_result", "host-verified"], ["command_result", "tool-observed"],
    ]));
    expect(core.inspect(commands()[0]!.id)).toMatchObject({ confidence: 0.95, tags: expect.arrayContaining(["host-verified"]) });
    expect(result.report.commit?.memories.revalidated).toBe(1);
  });

  it.each([
    { cmd: command, source: "caller-reported" as const },
    { cmd: "git status --short", source: "tool-observed" as const },
    { cmd: "npm run build", source: "tool-observed" as const },
    { cmd: `${command} || true`, source: "tool-observed" as const },
    { cmd: `${command} | tail`, source: "tool-observed" as const },
  ])("does not promote unverified command evidence: $source / $cmd", ({ cmd, source }) => {
    commit("commands", "output", source, cmd);
    expect(commands()).toEqual([]);
  });

  it("keeps different working directories, environment values and arguments distinct", () => {
    for (const cmd of [`cd a && ${command}`, `cd b && ${command}`, `MODE=strict ${command}`, command, `${command} --watch`]) {
      commit("commands", "passed", "tool-observed", cmd);
    }
    expect(commands()).toHaveLength(5);
  });

  it("audits only actual injection under a tight budget across a new Host session", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => core.record({ type: "convention", title: `Storage tests rule ${index}`, content: `Storage tests: ${"Use isolated state. ".repeat(400)}${index}`, confidence: 0.9 }).id);
    reopen();
    const { prompt, report } = await host("opencode", undefined, { budget: 1_000 });
    const injected = report.context.l1.injectedIds;
    expect(report.session.retrievedMemoryIds).toEqual(expect.arrayContaining(ids));
    expect(injected.length).toBeLessThan(ids.length);
    expect(report.context.l1.truncated).toBe(1);
    for (const id of ids) expect(prompt.includes(id)).toBe(injected.includes(id));
    const body = (start: string, end: string) => prompt.split(`${start}\n`)[1]!.split(`\n\n${end}`)[0]!;
    const l3 = body("## Repository Profile (L3)", "## Relevant Modules (L2)");
    const l2 = body("## Relevant Modules (L2)", "## Task Memories (L1)");
    const l1 = body("## Task Memories (L1)", "## Current Task");
    expect(report.context.contextChars).toBe(l1.length + l2.length + l3.length);
    expect(report.context.contextChars).toBeLessThanOrEqual(1_000);
    expect(report.context.promptChars).toBe(prompt.length);
    expect(report.context.promptSha256).toBe(createHash("sha256").update(prompt).digest("hex"));
    expect(core.inspectHostRun(report.runId).metadata.context).toEqual(report.context);
  });
});
