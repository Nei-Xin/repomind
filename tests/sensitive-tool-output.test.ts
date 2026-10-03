import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import { createOpenCodeHostAdapter } from "../src/integrations/opencode/adapter.js";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import { backupRepository } from "../src/portability/repository-data.js";
import { initializeRepository } from "../src/repository.js";
import { redactAgentTranscript, redactDeep } from "../src/security/redaction.js";
import { SENSITIVE_TOOL_CONTENT } from "../src/security/tool-output.js";
import { createTestRepository } from "./helpers.js";

// Deliberately not a recognizable credential: only path filtering can catch it.
const privateBody = "opaque orchard lantern cinnamon";
const publicBody = "ordinary tool output stays visible";

describe("sensitive tool data", () => {
  it.each([
    { file_path: "/repo/.env.local" }, { filePath: "C:\\repo\\.env" },
    { path: "secrets/server.pem" }, { path: "a/client.key" },
    { filePath: "a/cert.p12" }, { path: "a/cert.pfx" },
    { path: ".npmrc" }, { path: "/home/user/.ssh/id_rsa" }, { path: "id_ed25519.pub" },
    { command: "cat .env" }, { command: 'cat "/my repo/.env.production"' },
    { command: "grep DATABASE < config/.env" }, { command: "source .env && printenv" },
    { command: "Get-Content C:\\repo\\.env" },
    { path: ".env", content: privateBody },
  ])("suppresses arbitrary bodies for %j while retaining collector status", (toolInput) => {
    const result = redactDeep({ toolName: "Bash", toolInput, observedExitCode: null,
      toolResponse: { stdout: privateBody, stderr: privateBody, exitCode: 7, interrupted: false, metadata: { exit: 7 } }, error: privateBody });
    expect(JSON.stringify(result.value)).not.toContain(privateBody);
    expect(result.value).toMatchObject({ observedExitCode: null, toolResponse: { exitCode: 7, interrupted: false, metadata: { exit: 7 } } });
    expect(result.redactions).toBeGreaterThan(0);
    expect(redactDeep(result.value)).toEqual({ value: result.value, redactions: 0 });
  });

  it("preserves ordinary output and pairs interleaved Claude tool results", () => {
    const events = [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "private", name: "Read", input: { file_path: ".env" } },
        { type: "tool_use", id: "public", name: "Read", input: { file_path: "README.md" } },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "public", content: publicBody }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "private", content: privateBody, is_error: false }] }, tool_use_result: { stdout: privateBody, exitCode: 0 } },
    ];
    const result = redactAgentTranscript(events.map(JSON.stringify).join("\n"));
    expect(result.content).not.toContain(privateBody);
    expect(result.content).toContain(publicBody);
    expect(JSON.parse(result.content.split("\n")[2]!)).toMatchObject({ tool_use_result: { exitCode: 0 } });
    const plain = { toolName: "Read", toolInput: { file_path: "README.md" }, toolResponse: publicBody };
    expect(redactDeep(plain).value).toEqual(plain);
  });

  it("preserves sensitive command identity for failure and recovery tracking", () => {
    const command = "npm test -- .env";
    expect(redactDeep({ command, exitCode: 1, summary: privateBody }).value)
      .toEqual({ command, exitCode: 1, summary: SENSITIVE_TOOL_CONTENT });
  });

  it("suppresses numeric file bodies while preserving only collector status fields", () => {
    const clean = redactDeep({ toolInput: { path: ".env" }, toolResponse: {
      stdout: { code: 123456, nested: [789012, true] }, exitCode: 0, interrupted: false,
    } }).value;
    expect(JSON.stringify(clean)).not.toMatch(/123456|789012/);
    expect(clean.toolResponse).toMatchObject({ exitCode: 0, interrupted: false });
  });

  it("suppresses unpaired and truncated results without exposing partial file bodies", () => {
    const result = redactAgentTranscript([
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "missing", content: privateBody }] } }),
      `{"type":"tool_use","output":"${privateBody}`,
    ].join("\n"));
    expect(result.content).not.toContain(privateBody);
  });
});

describe("sensitive output persistence boundaries", () => {
  let repository: string, dataDirectory: string;
  beforeEach(() => {
    repository = createTestRepository();
    dataDirectory = mkdtempSync(join(tmpdir(), "repomind-sensitive-output-"));
    vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
    initializeRepository(repository).database.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it.each(["claude", "opencode"] as const)("filters %s L0, Evidence, physical backup and extraction input", async (agent) => {
    const store = new InteractiveActivityStore(repository, dataDirectory);
    const common = { schemaVersion: 1, agent, agentSessionId: "secret-test", repositoryPath: repository } as const;
    const started = store.startTask({ ...common, eventId: "start", task: "Inspect configuration" });
    try {
      for (const [i, toolInput] of [{ file_path: ".env" }, { command: "cat .env" }, { command: "cat README.txt" }].entries()) {
        store.record({ ...common, eventId: `tool-${i}`, type: "tool_result", source: agent === "claude" ? "claude-hook" : "opencode-plugin",
          payload: { toolName: i === 0 ? "Read" : "Bash", toolInput,
            toolResponse: { stdout: i === 2 ? publicBody : privateBody, exitCode: i === 1 ? 7 : 0 } } });
      }
      store.finish({ ...common, eventId: "finish", summary: "Inspected configuration." });
      const db = store.core.context.database.raw;
      for (const table of ["activity_events", "evidence"]) {
        const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
        expect(rows).not.toContain(privateBody);
        expect(rows).toContain(publicBody);
        expect(rows).toContain(SENSITIVE_TOOL_CONTENT);
      }
      const commands = db.prepare("SELECT metadata_json FROM evidence WHERE kind='command_result'").all() as Array<{ metadata_json: string }>;
      expect(commands.map(row => JSON.parse(row.metadata_json).exitCode).sort()).toEqual([0, 7]);
      const backup = join(dataDirectory, "filtered.sqlite");
      backupRepository(store.core.context, backup);
      expect(readFileSync(backup).includes(Buffer.from(privateBody))).toBe(false);
    } finally { store.close(); }
    let request = "";
    const core = new RepositoryMemoryCore(repository, { dataDirectory, extractionRunner: {
      id: "mock", model: "fixture", remote: true,
      async run(input) { request = JSON.stringify(input); return { output: { candidates: [] } }; },
    } });
    try {
      await core.extractSession({ sessionId: started.sessionId });
      expect(request).toContain(publicBody);
      expect(request).not.toContain(privateBody);
    } finally { core.close(); }
  });

  it("also filters explicit command Evidence and command memory bodies", () => {
    const core = new RepositoryMemoryCore(repository, { dataDirectory });
    try {
      const started = core.startSession({ task: "Check configuration" });
      core.commitSession({ sessionId: started.sessionId, idempotencyKey: "explicit", status: "success", summary: "Checked configuration.",
        tests: [{ command: "npm test -- .env", exitCode: 0, summary: privateBody }] }, { tests: "host-verified" });
      for (const table of ["evidence", "memories"]) expect(JSON.stringify(core.context.database.raw.prepare(`SELECT * FROM ${table}`).all())).not.toContain(privateBody);
    } finally { core.close(); }
  });

  it.each([
    { response: { exitCode: 1, stdout: privateBody }, expected: "partial" },
    { response: `${privateBody}\nProcess exited with code 1`, expected: "partial" },
    { response: `${privateBody}\nProcess exited with code 0`, expected: "committed" },
    { response: privateBody, expected: "partial" },
  ])("preserves test status when sensitive output is suppressed: $expected", ({ response, expected }) => {
    const store = new InteractiveActivityStore(repository, dataDirectory);
    try {
      const common = { schemaVersion: 1, agent: "claude", agentSessionId: "sensitive-failure", repositoryPath: repository } as const;
      store.startTask({ ...common, eventId: "start", task: "Verify configuration" });
      store.record({ ...common, eventId: "test", type: "tool_result", source: "claude-hook", payload: {
        toolName: "Bash", toolInput: { command: "npm test -- .env" }, toolResponse: response,
      } });
      expect(store.finish({ ...common, eventId: "finish", summary: "Verification completed." }).status).toBe(expected);
    } finally { store.close(); }
  });

  it.each(["opencode", "claude"] as const)("filters %s Host artifacts and Evidence", async (runner) => {
    const execute = async () => {
      const events: unknown[] = [];
      for (const [id, tool, input, output] of [
        ["read", "Read", { file_path: ".env" }, privateBody],
        ["shell", "Bash", { command: "cat .env" }, privateBody],
        ["public", "Bash", { command: "cat README.txt" }, publicBody],
      ] as const) {
        if (runner === "opencode") events.push({ type: "tool_use", part: { tool: tool.toLowerCase(), state: { status: "completed", input, output, metadata: { exit: 0 } } } });
        else events.push(
          { type: "assistant", message: { content: [{ type: "tool_use", id, name: tool, input }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }] }, tool_use_result: { stdout: output, exitCode: 0 } },
        );
      }
      if (runner === "opencode") events.push({ type: "text", part: { text: "Inspected configuration." } }, { type: "step_finish", part: { reason: "stop" } });
      else events.push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "Inspected configuration." });
      return { exitCode: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", durationMs: 1, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false };
    };
    const report = await runAgentHost({ repository, dataDirectory, outputDirectory: join(dataDirectory, "run"), task: "Inspect configuration",
      adapter: runner === "opencode" ? createOpenCodeHostAdapter({ execute }) : createClaudeHostAdapter({ execute }) });
    expect(report.quality.status).toBe("success");
    expect(report.attempts[0]!.outcome.commands.map(c => c.exitCode)).toEqual([0, 0]);
    for (const path of [report.artifacts.events, report.artifacts.report, report.attempts[0]!.artifacts.stdout]) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain(privateBody);
      expect(content).toContain(publicBody);
    }
    const core = new RepositoryMemoryCore(repository, { dataDirectory });
    try {
      expect(JSON.stringify(core.context.database.raw.prepare("SELECT * FROM evidence").all())).not.toContain(privateBody);
      expect(core.context.database.raw.prepare("SELECT id FROM memories WHERE type='command'").all()).toHaveLength(0);
    } finally { core.close(); }
  });
});
