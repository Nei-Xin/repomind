import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { handleCodexInteractiveHook } from "../src/integrations/codex/interactive-hook.js";
import { createPiExtension, type PiContext } from "../src/integrations/pi/extension.js";
import { installNativeIntegration, inspectNativeIntegration } from "../src/integrations/native/install.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const servers: RunningBridgeServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
  const repository = createTestRepository("repomind-native-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-native-data-"));
  cleanup.push(repository, dataDirectory);
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(repository).database.close();
  const bridge = await startBridgeServer({ port: 0, dataDirectory });
  servers.push(bridge);
  const core = () => new RepositoryMemoryCore(repository, { dataDirectory });
  const query = (sql: string) => { const c = core(); try { return c.context.database.raw.prepare(sql).all(); } finally { c.close(); } };
  const warnings: string[] = [];
  const options = { bridgeUrl: bridge.url, onWarning: (s: string) => warnings.push(s) };
  const codex = (event: string, turn: string, extra = {}) => handleCodexInteractiveHook({ ...options,
    input: { hook_event_name: event, session_id: "codex-session", cwd: repository, turn_id: turn, ...extra } });
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: PiContext) => Promise<unknown>>();
  createPiExtension(options)({ on: (event, handler) => { handlers.set(event, handler); } });
  const ctx: PiContext = { cwd: repository, sessionManager: { getSessionId: () => "pi-session" } };
  const pi = (event: string, value: Record<string, unknown> = {}) => handlers.get(event)?.(value, ctx);
  return { repository, core, query, warnings, codex, pi, bridge };
}

describe("native Pi and Codex integration", () => {
  it("captures Codex command evidence and recalls it in native Pi without MCP", async () => {
    const f = await fixture();
    await f.codex("UserPromptSubmit", "turn-1", { prompt: "Document invoice verification" });
    writeFileSync(join(f.repository, "README.txt"), "Verify invoices with npm test -- invoice\n");
    const tool = { tool_name: "Bash", tool_use_id: "tool-1", tool_input: { command: "npm test -- invoice" } };
    await f.codex("PreToolUse", "turn-1", tool);
    await f.codex("PostToolUse", "turn-1", { ...tool, tool_response: { exit_code: 0, output: "1 test passed" } });
    await f.codex("Stop", "turn-1", { last_assistant_message: "Documented and verified the invoice test command." });
    expect(f.query("SELECT client_name,status FROM sessions")).toEqual([{ client_name: "codex-interactive", status: "committed" }]);
    const result = await f.pi("before_agent_start", { messageType: "user", prompt: "Which invoice verification command should I run?" });
    expect(result).toMatchObject({ message: { customType: "repomind-context", display: false, content: expect.stringContaining("npm test -- invoice") } });
    await f.pi("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Run npm test -- invoice." }], stopReason: "stop" } });
    await f.pi("agent_settled", { aborted: false });
    expect(f.warnings).toEqual([]);
  });

  it("rejects delayed Codex events and records cancellation without committing memories", async () => {
    const f = await fixture();
    await f.codex("UserPromptSubmit", "old", { prompt: "Old task" });
    await f.codex("UserPromptSubmit", "new", { prompt: "New task" });
    await f.codex("Stop", "old", { last_assistant_message: "Late completion" });
    await f.codex("Interrupt", "old");
    await f.codex("PostToolUse", "old", { tool_name: "Bash", tool_use_id: "late", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    expect(f.query("SELECT task,status FROM sessions ORDER BY task")).toEqual([
      { task: "New task", status: "open" }, { task: "Old task", status: "partial" },
    ]);
    await f.codex("Interrupt", "new");
    expect(f.query("SELECT status FROM sessions WHERE task='New task'")).toEqual([{ status: "abandoned" }]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.warnings).toHaveLength(3);
  });

  it("does not treat Codex nonzero exits or missing exit codes as verified success", async () => {
    const f = await fixture();
    for (const [turn, response] of [["failed", { exit_code: 2 }], ["unknown", "exit code 0\nTests passed"]] as const) {
      await f.codex("UserPromptSubmit", turn, { prompt: `Run ${turn} tests` });
      await f.codex("PostToolUse", turn, { tool_name: "Bash", tool_use_id: turn, tool_input: { command: "npm test" }, tool_response: response });
      await f.codex("Stop", turn, { last_assistant_message: "Tests passed" });
    }
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "partial" }, { status: "partial" }]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.warnings).toEqual([]);
  });

  it("waits for Pi settled, handles retries, and never commits an aborted run", async () => {
    const f = await fixture();
    await f.pi("before_agent_start", { messageType: "user", prompt: "Check tests" });
    await f.pi("message_end", { message: { role: "assistant", stopReason: "error", content: [] } });
    await f.pi("agent_end", { messages: [] });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "open" }]);
    await f.pi("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered after retry." }] } });
    await f.pi("agent_settled", { aborted: false });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "committed" }]);
    await f.pi("before_agent_start", { messageType: "user", prompt: "Run more tests" });
    await f.pi("tool_result", { toolName: "bash", toolCallId: "cancel-test", input: { command: "npm test" }, content: [], structuredContent: { exit_code: 0 }, isError: false });
    await f.pi("agent_settled", { aborted: true });
    expect(f.query("SELECT status FROM sessions WHERE task='Run more tests'")).toEqual([{ status: "abandoned" }]);
    expect(f.query("SELECT id FROM evidence WHERE kind='test_result'")).toEqual([]);
    expect(f.warnings).toEqual([]);
  });

  it("records explicit Pi exits and redacts sensitive file output", async () => {
    const f = await fixture();
    await f.pi("before_agent_start", { messageType: "user", prompt: "Run tests and inspect environment" });
    await f.pi("tool_result", { toolName: "bash", toolCallId: "test", input: { command: "npm test" }, content: [{ type: "text", text: "passed" }], structuredContent: { exit_code: 0 }, isError: false });
    await f.pi("tool_result", { toolName: "read", toolCallId: "read", input: { path: ".env.local" }, content: [{ type: "text", text: "SECRET_MARKER=private-sentinel" }], isError: false });
    await f.pi("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Tests passed." }] } });
    await f.pi("agent_settled", { aborted: false });
    expect(f.query("SELECT kind FROM evidence WHERE kind='test_result'")).toEqual([{ kind: "test_result" }]);
    expect(JSON.stringify(f.query("SELECT payload_json FROM activity_events"))).not.toContain("private-sentinel");
    await f.pi("before_agent_start", { messageType: "user", prompt: "Unfinished task" });
    await f.pi("session_shutdown", { reason: "fork" });
    expect(f.query("SELECT status FROM sessions WHERE task='Unfinished task'")).toEqual([{ status: "abandoned" }]);
    expect(f.warnings).toEqual([]);
  });

  it("degrades without blocking when the Bridge is unavailable", async () => {
    const f = await fixture();
    await f.bridge.close();
    servers.splice(servers.indexOf(f.bridge), 1);
    await expect(f.codex("UserPromptSubmit", "unavailable", { prompt: "Keep working" })).resolves.toMatchObject({ systemMessage: expect.stringContaining("unavailable") });
    await expect(f.pi("before_agent_start", { messageType: "user", prompt: "Keep working" })).resolves.toBeUndefined();
    await expect(f.pi("agent_settled", { aborted: false })).resolves.toBeUndefined();
    expect(f.warnings).toHaveLength(2);
  });

  it("keeps Pi errors and truncated answers out of successful memory and ignores custom runs", async () => {
    const f = await fixture();
    await f.pi("before_agent_start", { messageType: "custom", message: { content: "Extension reminder" } });
    await f.pi("agent_settled", { aborted: false });
    expect(f.query("SELECT id FROM sessions")).toEqual([]);
    for (const reason of ["error", "length"]) {
      await f.pi("before_agent_start", { messageType: "user", prompt: `Model outcome ${reason}` });
      writeFileSync(join(f.repository, "README.txt"), `Unfinished change ${reason}\n`);
      await f.pi("message_end", { message: { role: "assistant", stopReason: reason, content: [{ type: "text", text: "Incomplete answer" }] } });
      await f.pi("agent_settled", { aborted: false });
    }
    expect(f.query("SELECT status FROM sessions ORDER BY task")).toEqual([{ status: "failed" }, { status: "partial" }]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.warnings).toEqual([]);
  });

  it("ignores Codex subagent events and deduplicates replayed tool hooks", async () => {
    const f = await fixture();
    await f.codex("UserPromptSubmit", "main", { prompt: "Main task" });
    await f.codex("Stop", "main", { agent_id: "child", last_assistant_message: "Child finished" });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "open" }]);
    const tool = { tool_name: "Bash", tool_use_id: "repeat", tool_input: { command: "pwd" }, tool_response: "working directory" };
    await f.codex("PostToolUse", "main", tool);
    await f.codex("PostToolUse", "main", tool);
    expect(f.query("SELECT count(*) n FROM activity_events WHERE event_type='tool_result'")).toEqual([{ n: 1 }]);
    await f.codex("Stop", "main", { last_assistant_message: "Main finished" });
    expect(f.warnings).toEqual([]);
  });

  it("installs idempotently, repairs moved paths, preserves other hooks and rejects unmanaged Pi files", async () => {
    const f = await fixture();
    const entry = join(f.repository, "entry.js");
    const moved = join(f.repository, "moved '$() entry.js");
    writeFileSync(entry, "export default () => {};\n");
    writeFileSync(moved, "export default () => {};\n");
    const base = { repository: f.repository, cliEntry: entry, extensionEntry: entry };
    mkdirSync(join(f.repository, ".codex"));
    const path = join(f.repository, ".codex/hooks.json");
    writeFileSync(path, JSON.stringify({ description: "keep", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }));
    for (const agent of ["codex", "pi"] as const) {
      expect(installNativeIntegration({ ...base, agent }).configured).toBe(true);
      expect(installNativeIntegration({ ...base, agent }).changed).toBe(false);
      expect(installNativeIntegration({ ...base, agent, cliEntry: moved, extensionEntry: moved }).changed).toBe(true);
      expect(inspectNativeIntegration({ ...base, agent, cliEntry: moved, extensionEntry: moved }).configured).toBe(true);
    }
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.description).toBe("keep");
    expect(config.hooks.Stop).toHaveLength(2);
    expect(config.hooks.Stop[0].hooks[0].command).toBe("echo other");
    expect(config.hooks.Interrupt[0].hooks[0].timeout).toBe(3);
    writeFileSync(join(f.repository, ".pi/extensions/repomind.ts"), "// user's own extension\n");
    expect(() => installNativeIntegration({ ...base, agent: "pi" })).toThrow("unmanaged");
  });
});
