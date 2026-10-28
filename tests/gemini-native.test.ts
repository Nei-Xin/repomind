import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { handleGeminiInteractiveHook } from "../src/integrations/gemini/interactive-hook.js";
import { handleCodexInteractiveHook } from "../src/integrations/codex/interactive-hook.js";
import { installNativeIntegration, inspectNativeIntegration } from "../src/integrations/native/install.js";
import { createTestRepository } from "./helpers.js";
const cleanup: string[] = [];
const servers: RunningBridgeServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(s => s.close()));
  cleanup.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});
async function fixture() {
  const repository = createTestRepository("repomind-gemini-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-gemini-data-"));
  cleanup.push(repository, dataDirectory);
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(repository).database.close();
  const bridge = await startBridgeServer({ port: 0, dataDirectory }); servers.push(bridge);
  const warnings: string[] = [];
  const options = { bridgeUrl: bridge.url, onWarning: (s: string) => warnings.push(s) };
  let clock = Date.now();
  const input = (event: string, extra = {}) => ({ hook_event_name: event, session_id: "gemini-test", cwd: repository,
    timestamp: new Date(++clock).toISOString(), ...extra });
  const hook = (event: string, extra = {}) => handleGeminiInteractiveHook({ ...options, input: input(event, extra) });
  const query = (sql: string) => { const c = new RepositoryMemoryCore(repository, { dataDirectory }); try { return c.context.database.raw.prepare(sql).all(); } finally { c.close(); } };
  const model = async (finishReason = "STOP") => {
    await hook("BeforeModel", { llm_request: { model: "test" } });
    await hook("AfterModel", { llm_request: { model: "test" }, llm_response: { candidates: [{ finishReason }] } });
  };
  return { repository, dataDirectory, bridge, warnings, options, input, hook, query, model };
}
describe("Gemini native hooks", () => {
  it("captures edits, finishes only after terminal model success and recalls in another client", async () => {
    const f = await fixture();
    await f.hook("BeforeAgent", { prompt: "Document invoice verification" });
    writeFileSync(join(f.repository, "README.txt"), "Verify invoices with npm test -- invoice\n");
    const tool = { tool_name: "run_shell_command", tool_input: { command: "npm test -- invoice" } };
    await f.hook("BeforeTool", tool);
    await f.hook("AfterTool", { ...tool, tool_response: { data: { exitCode: 0 }, llmContent: "1 passed" } });
    await f.model();
    await f.hook("AfterAgent", { prompt: "Document invoice verification", prompt_response: "Documented invoice validation." });
    expect(f.query("SELECT client_name,status FROM sessions")).toEqual([{ client_name: "gemini-interactive", status: "committed" }]);
    const result = await handleCodexInteractiveHook({ ...f.options, input: { hook_event_name: "UserPromptSubmit", session_id: "codex-test", cwd: f.repository, turn_id: "one", prompt: "Which invoice verification command should I run?" } });
    expect(result).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("npm test -- invoice") } });
    expect(f.warnings).toEqual([]);
  });
  it("deduplicates hooks, separates identical prompts and ignores late completion", async () => {
    const f = await fixture();
    const start = f.input("BeforeAgent", { prompt: "Repeat task" });
    await handleGeminiInteractiveHook({ ...f.options, input: start });
    await handleGeminiInteractiveHook({ ...f.options, input: start });
    const late = f.input("AfterAgent", { prompt: "Repeat task", prompt_response: "late" });
    await f.hook("BeforeAgent", { prompt: "Repeat task" });
    await handleGeminiInteractiveHook({ ...f.options, input: late });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "abandoned" }, { status: "open" }]);
    await f.model();
    await f.hook("AfterAgent", { prompt: "Repeat task", prompt_response: "Potentially ambiguous" });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "abandoned" }, { status: "partial" }]);
    expect(f.warnings).toEqual([]);
  });
  it("keeps cancelled/truncated/unknown-exit work out of successful memories", async () => {
    const f = await fixture();
    for (const reason of ["MAX_TOKENS", "SAFETY", "missing", "unknown-exit"]) {
      await f.hook("BeforeAgent", { prompt: reason });
      writeFileSync(join(f.repository, "README.txt"), `Change ${reason}\n`);
      if (reason === "unknown-exit") {
        const tool = { tool_name: "run_shell_command", tool_input: { command: "npm test" } };
        await f.hook("BeforeTool", tool);
        await f.hook("AfterTool", { ...tool, tool_response: { llmContent: "Exit Code: 0\nall tests passed" } });
      }
      if (reason !== "missing") await f.model(reason === "unknown-exit" ? "STOP" : reason);
      await f.hook("AfterAgent", { prompt: reason, prompt_response: "Partial answer" });
    }
    expect(f.query("SELECT status FROM sessions")).toEqual(Array(4).fill({ status: "partial" }));
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.query("SELECT id FROM evidence WHERE kind='test_result'")).toEqual([]);
    expect(f.warnings).toEqual([]);
  });
  it("correlates distinct parallel calls, rejects ambiguous calls and redacts sensitive output", async () => {
    const f = await fixture();
    await f.hook("BeforeAgent", { prompt: "Inspect files" });
    const a = { tool_name: "read_file", tool_input: { file_path: ".env.local" } };
    const b = { tool_name: "read_file", tool_input: { file_path: "README.txt" } };
    await Promise.all([f.hook("BeforeTool", a), f.hook("BeforeTool", b)]);
    await Promise.all([f.hook("AfterTool", { ...b, tool_response: { llmContent: "public" } }), f.hook("AfterTool", { ...a, tool_response: { llmContent: "private-sentinel" } })]);
    expect(f.query("SELECT count(*) n FROM activity_events WHERE event_type='tool_result'")).toEqual([{ n: 2 }]);
    const tool = { tool_name: "run_shell_command", tool_input: { command: "npm test" } };
    await f.hook("BeforeTool", tool); await f.hook("BeforeTool", tool);
    await f.hook("AfterTool", { ...tool, tool_response: { data: { exitCode: 0 } } });
    await f.model(); await f.hook("AfterAgent", { prompt: "Inspect files", prompt_response: "Done" });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "partial" }]);
    expect(JSON.stringify(f.query("SELECT payload_json FROM activity_events"))).not.toContain("private-sentinel");
    const sidecar = join(f.dataDirectory, "gemini-hooks");
    expect(readdirSync(sidecar).map(p => readFileSync(join(sidecar,p)).toString()).join()).not.toContain("private-sentinel");
    expect(f.warnings).toEqual([]);
  });
  it("cleans up interrupted sessions on resume and does not mix late tools into a new prompt", async () => {
    const f = await fixture();
    await f.hook("BeforeAgent", { prompt: "Old" });
    const tool = { tool_name: "run_shell_command", tool_input: { command: "npm test" } };
    await f.hook("BeforeTool", tool);
    await f.hook("SessionStart", { source: "resume" });
    await f.hook("BeforeAgent", { prompt: "New" });
    await f.hook("BeforeTool", tool);
    await f.hook("AfterTool", { ...tool, tool_response: { data: { exitCode: 0 } } });
    await f.model(); await f.hook("AfterAgent", { prompt: "New", prompt_response: "Done" });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "abandoned" }, { status: "partial" }]);
    expect(f.query("SELECT id FROM evidence WHERE kind='test_result'")).toEqual([]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.warnings).toEqual([]);
  });
  it("retries an unavailable Bridge with the same hook without creating duplicate tasks", async () => {
    const f = await fixture();
    const input = f.input("BeforeAgent", { prompt: "Retry connection" });
    const failed = await handleGeminiInteractiveHook({ ...f.options, bridgeUrl: "http://127.0.0.1:1", recover: false, input });
    expect(failed).toHaveProperty("systemMessage");
    await handleGeminiInteractiveHook({ ...f.options, input });
    await f.hook("SessionEnd", { reason: "exit" });
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "abandoned" }]);
    expect(f.warnings).toHaveLength(1);
  });
  it("preserves configuration and disabled hooks, repairs paths and installs idempotently", async () => {
    const f = await fixture();
    mkdirSync(join(f.repository, ".gemini"));
    const path = join(f.repository, ".gemini/settings.json");
    const entry = join(f.repository, "entry '$() .js"); writeFileSync(entry, "");
    const config = { model: { name: "existing-model" }, security: { auth: { selectedType: "gemini-api-key" } }, hooksConfig: { enabled: false, disabled: ["repomind-AfterAgent"] }, hooks: { AfterAgent: [{ hooks: [{ type: "command", command: "echo other" }] }] } };
    writeFileSync(path, JSON.stringify(config));
    const options = { agent: "gemini" as const, repository: f.repository, cliEntry: entry, extensionEntry: entry, modelHookEntry: entry };
    expect(installNativeIntegration(options)).toMatchObject({ configured: false, disabled: true, changed: true, missingEvents: [] });
    expect(installNativeIntegration(options).changed).toBe(false);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    expect(installed.model).toEqual(config.model); expect(installed.security).toEqual(config.security);
    expect(installed.hooksConfig).toEqual(config.hooksConfig);
    expect(installed.hooks.AfterAgent).toHaveLength(2);
    expect(installed.hooks.SessionEnd[0].hooks[0].timeout).toBe(2000);
    installed.hooksConfig = { enabled: true };
    writeFileSync(path, JSON.stringify(installed));
    expect(inspectNativeIntegration(options).configured).toBe(true);
    const moved = join(f.repository, "moved.js"); writeFileSync(moved, "");
    expect(installNativeIntegration({ ...options, cliEntry: moved }).changed).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.AfterAgent).toHaveLength(2);
  });
});
