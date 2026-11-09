import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createDshPlugin, type DshContext, type DshDecision, type DshSession } from "../src/integrations/dsh/plugin.js";
import { installDshPlugin, inspectDshPlugin } from "../src/integrations/dsh/setup.js";
import { createPiExtension, type PiContext } from "../src/integrations/pi/extension.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const servers: RunningBridgeServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
  const repository = createTestRepository("repomind-dsh-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-dsh-data-"));
  cleanup.push(repository, dataDirectory);
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(repository).database.close();
  const bridge = await startBridgeServer({ port: 0, dataDirectory });
  servers.push(bridge);
  const query = (sql: string) => {
    const core = new RepositoryMemoryCore(repository, { dataDirectory });
    try { return core.context.database.raw.prepare(sql).all(); } finally { core.close(); }
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const warnings: string[] = [];
  const options = { repository, bridgeUrl: bridge.url, onWarning: (s: string) => warnings.push(s) };
  let cwd = repository;
  createDshPlugin(options)({ workingDirectory: { get: () => cwd },
    effect: setup => { handlers.set("dispose", setup()); },
    on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); } } as DshContext);
  const session = (id = "root", origin?: string): DshSession => ({ id, header: origin ? { origin } : {} });
  const emit = (event: string, ...args: any[]) => handlers.get(event)?.(...args);
  const start = async (s: DshSession, task: string, turn = 1, extra: { signal?: AbortSignal; decision?: DshDecision; source?: string; messageId?: string } = {}) => {
    const message = { id: extra.messageId ?? `${s.id}:${turn}`, role: "user", source: { kind: extra.source ?? "user" }, content: [{ type: "text", text: task }] };
    return emit("agent/pre-step", { agent: { session: s }, messages: [message], turn, step: 1,
      signal: extra.signal ?? new AbortController().signal }, async () => extra.decision ?? { kind: "enter", messages: [message] });
  };
  const finish = async (s: DshSession, reason = "completed", turn = 1, seq = 10, summary = "Implemented and verified the repository change.") => {
    emit("session/event", s, { type: "assistant/message", seq, data: { turn, message: { content: [{ type: "text", text: summary }] } } });
    emit("session/event", s, { type: "turn/end", seq: seq + 1, data: { turn, reason: { kind: reason } } });
    await emit("session/flush", s);
  };
  const tool = (s: DshSession, callId: string, command: string, value: unknown, extra = {}) => emit("tools/result", {
    agent: { session: s }, callId, name: "bash", arguments: { command },
  }, { isError: false, value, content: [{ type: "text", text: "exit code 0, everything passed" }], ...extra });
  return { repository, bridge, query, warnings, session, emit, start, finish, tool, options, setCwd: (path: string) => { cwd = path; } };
}

describe("DSH native plugin", () => {
  it("records canonical command evidence, drains on flush, and recalls across DSH and Pi sessions", async () => {
    const f = await fixture();
    const a = f.session("writer");
    await f.start(a, "Document invoice verification");
    writeFileSync(join(f.repository, "README.txt"), "Verify invoices with npm test -- invoice\n");
    f.tool(a, "test", "npm test -- invoice", { kind: "foreground", exitCode: 0, timedOut: false, aborted: false });
    await f.finish(a, "completed", 1, 10, "Documented and verified the invoice test command.");
    expect(f.query("SELECT client_name,status FROM sessions")).toEqual([{ client_name: "dsh-interactive", status: "committed" }]);
    expect(f.query("SELECT kind FROM evidence WHERE kind='test_result'")).toHaveLength(1);
    const b = f.session("reader");
    const decision = await f.start(b, "Which invoice verification command should I run?");
    expect(decision.messages.at(-1)).toMatchObject({ source: { kind: "repomind" }, content: [{ type: "text", text: expect.stringContaining("npm test -- invoice") }] });
    const piHandlers = new Map<string, (event: any, ctx: PiContext) => Promise<unknown>>();
    createPiExtension(f.options)({ on: (name, listener) => { piHandlers.set(name, listener); } });
    const pi = await piHandlers.get("before_agent_start")!({ prompt: "Which invoice verification command should I run?" }, {
      cwd: f.repository, sessionManager: { getSessionId: () => "pi-reader" },
    });
    expect(pi).toMatchObject({ message: { content: expect.stringContaining("npm test -- invoice") } });
    await f.emit("dispose");
    expect(f.warnings).toEqual([]);
  });

  it("verifies npm exec tests from canonical results and keeps failed runs partial", async () => {
    const f = await fixture();
    const passed = f.session("npm-exec-passed");
    await f.start(passed, "Verify the DSH plugin regression");
    const command = "npm exec vitest run tests/dsh-native.test.ts";
    f.tool(passed, "test", command, { kind: "foreground", exitCode: 0 });
    await f.finish(passed, "completed", 1, 10, "Verified the DSH plugin regression.");
    expect(f.query("SELECT kind FROM evidence WHERE kind='test_result'")).toHaveLength(1);
    const memories = JSON.stringify(f.query("SELECT * FROM memories WHERE type='command'"));
    expect(memories).toContain(command);
    expect(memories).toContain("tool-observed");

    const failed = f.session("npm-exec-failed");
    await f.start(failed, "Recheck the DSH plugin regression");
    f.tool(failed, "test", command, { kind: "foreground", exitCode: 1 });
    await f.finish(failed);
    expect(f.query("SELECT status FROM sessions ORDER BY task")).toEqual([
      { status: "partial" }, { status: "committed" },
    ]);
    expect(f.warnings).toEqual([]);
  });

  it("keeps concurrent sessions isolated and ignores children, context messages and rejected steps", async () => {
    const f = await fixture();
    await f.start(f.session("child", "subagent"), "child task");
    await f.start(f.session("context"), "runtime snapshot", 1, { source: "runtime-context" });
    await f.start(f.session("reject"), "rejected task", 1, { decision: { kind: "reject" } });
    const a = f.session("a"), b = f.session("b");
    await Promise.all([f.start(a, "Task alpha"), f.start(b, "Task beta")]);
    f.tool(a, "same-id", "npm test -- alpha", { kind: "foreground", exitCode: 0 });
    f.tool(b, "same-id", "npm test -- beta", { kind: "foreground", exitCode: 1 });
    await Promise.all([f.finish(a), f.finish(b)]);
    expect(f.query("SELECT task,status FROM sessions ORDER BY task")).toEqual([
      { task: "Task alpha", status: "committed" }, { task: "Task beta", status: "partial" },
    ]);
    expect(f.warnings).toEqual([]);
  });

  it("does not trust stdout exits, background acceptance, timed-out or missing canonical exits", async () => {
    const f = await fixture();
    const values = [{ kind: "background", exitCode: 0 }, { kind: "foreground", exitCode: null },
      { kind: "foreground", exitCode: 0, timedOut: true }, { kind: "foreground", exitCode: 0, aborted: true }];
    for (const [index, value] of values.entries()) {
      const s = f.session(`case-${index}`);
      await f.start(s, `Verification ${index}`);
      f.tool(s, "test", "npm test", value);
      await f.finish(s);
    }
    expect(f.query("SELECT status FROM sessions")).toEqual(values.map(() => ({ status: "partial" })));
    expect(f.query("SELECT id FROM evidence WHERE kind='test_result'")).toEqual([]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
  });

  it("deduplicates replay, preserves steering in the same turn, and starts a new task after resume", async () => {
    const f = await fixture();
    const s = f.session();
    await f.start(s, "Initial task");
    await f.start(s, "Initial task");
    await f.start(s, "Also check tests", 1, { messageId: "steer" });
    f.tool(s, "test", "npm test", { kind: "foreground", exitCode: 0 });
    f.tool(s, "test", "npm test", { kind: "foreground", exitCode: 0 });
    await f.finish(s);
    await f.finish(s);
    expect(f.query("SELECT id FROM sessions")).toHaveLength(1);
    expect(f.query("SELECT id FROM activity_events WHERE event_type='tool_result'")).toHaveLength(1);
    expect(f.query("SELECT id FROM activity_events WHERE event_type='user_message'")).toHaveLength(2);
    await f.start(s, "Resumed task", 2);
    // Delayed old-turn terminal must not close the new task.
    await f.finish(s, "completed", 1, 12);
    expect(f.query("SELECT status FROM sessions WHERE task='Resumed task'")).toEqual([{ status: "open" }]);
    await f.finish(s, "completed", 2, 20);
    expect(f.query("SELECT status FROM sessions WHERE task='Resumed task'")).toEqual([{ status: "committed" }]);
    expect(f.warnings).toEqual([]);
  });

  it("aborts interruptions and disposal; errors, truncation and missing tool results cannot commit success", async () => {
    const f = await fixture();
    for (const reason of ["aborted", "interrupted", "error", "max-tokens", "blocked"]) {
      const s = f.session(reason);
      await f.start(s, reason);
      await f.finish(s, reason);
    }
    const missing = f.session("missing");
    await f.start(missing, "missing");
    f.emit("session/event", missing, { type: "tool/call", seq: 2, data: { turn: 1, callId: "lost", name: "bash", arguments: '{"command":"npm test"}' } });
    await f.finish(missing);
    const disposed = f.session("dispose");
    await f.start(disposed, "dispose");
    f.emit("session/disposed", disposed);
    await f.emit("dispose");
    expect(f.query("SELECT task,status FROM sessions ORDER BY task")).toEqual([
      { task: "aborted", status: "abandoned" }, { task: "blocked", status: "partial" },
      { task: "dispose", status: "abandoned" }, { task: "error", status: "failed" },
      { task: "interrupted", status: "abandoned" }, { task: "max-tokens", status: "partial" },
      { task: "missing", status: "partial" },
    ]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
  });

  it("records custom-executor results conservatively and redacts sensitive tool content", async () => {
    const f = await fixture();
    const s = f.session();
    await f.start(s, "Check tests and configuration");
    f.emit("session/event", s, { type: "tool/call", seq: 2, data: { turn: 1, callId: "custom", name: "bash", arguments: '{"command":"npm test"}' } });
    f.emit("session/event", s, { type: "tool/result", seq: 3, data: { turn: 1, message: { toolCallId: "custom", content: [{ type: "text", text: "exit code 0" }] } } });
    f.emit("tools/result", { agent: { session: s }, callId: "read", name: "read", arguments: { file_path: ".env.local" } },
      { isError: false, content: [{ type: "text", text: "OPAQUE_PRIVATE_SENTINEL" }] });
    await f.finish(s);
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "partial" }]);
    expect(JSON.stringify(f.query("SELECT payload_json FROM activity_events"))).not.toContain("OPAQUE_PRIVATE_SENTINEL");
  });

  it("does not follow a session into another repository", async () => {
    const f = await fixture();
    const s = f.session();
    await f.start(s, "Original repository");
    const other = createTestRepository("repomind-dsh-other-");
    cleanup.push(other);
    f.setCwd(other);
    await f.start(s, "Different repository", 2);
    expect(f.query("SELECT task,status FROM sessions")).toEqual([{ task: "Original repository", status: "abandoned" }]);
  });

  it("continues without memory when Bridge recall fails, without recording later events against an old task", async () => {
    const f = await fixture();
    await f.bridge.close();
    servers.splice(servers.indexOf(f.bridge), 1);
    const s = f.session();
    const decision = await f.start(s, "Keep working");
    expect(decision.messages).toHaveLength(1);
    f.tool(s, "test", "npm test", { kind: "foreground", exitCode: 0 });
    await f.finish(s);
    expect(f.query("SELECT id FROM sessions")).toEqual([]);
    expect(f.warnings).toHaveLength(1);
  });

  it("abandons a start accepted by the Bridge when recall is interrupted", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const response = await fetchOriginal(url, init);
      if (String(url).endsWith("/v1/tasks/start")) controller.abort();
      return response;
    });
    const s = f.session();
    const decision = await f.start(s, "Interrupted recall", 1, { signal: controller.signal });
    expect(decision.messages).toHaveLength(1);
    await f.finish(s);
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "abandoned" }]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
  });

  it("downgrades a completed turn when recording an activity failed", async () => {
    const f = await fixture();
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).endsWith("/v1/activities") && body.type === "tool_result") {
        return new Response(JSON.stringify({ error: { message: "Injected write failure" } }), { status: 503 });
      }
      return fetchOriginal(url, init);
    });
    const s = f.session();
    await f.start(s, "Unrecorded verification");
    f.tool(s, "test", "npm test", { kind: "foreground", exitCode: 0 });
    await f.finish(s);
    expect(f.query("SELECT status FROM sessions")).toEqual([{ status: "partial" }]);
    expect(f.query("SELECT id FROM memories")).toEqual([]);
    expect(f.warnings).toHaveLength(1);
  });

  it("repairs a stale overlay when the plugin entry moves and reinstalls idempotently", async () => {
    const f = await fixture();
    const oldEntry = join(f.repository, "old-plugin.js");
    const newEntry = join(f.repository, "new plugin's entry.js");
    writeFileSync(oldEntry, "export function apply() {}\n");
    writeFileSync(newEntry, "export function apply() {}\n");
    const oldOptions = { repository: f.repository, pluginEntry: oldEntry };
    const newOptions = { repository: f.repository, pluginEntry: newEntry };
    const oldUrl = pathToFileURL(oldEntry).href;
    const newUrl = pathToFileURL(newEntry).href;

    const installed = installDshPlugin(oldOptions);
    expect(installed).toMatchObject({ configured: true, changed: true });
    expect(readFileSync(installed.path, "utf8")).toContain(JSON.stringify(oldUrl));
    expect(inspectDshPlugin(newOptions)).toMatchObject({
      path: installed.path, installed: true, managed: true, configured: false,
    });

    const repaired = installDshPlugin(newOptions);
    expect(repaired).toMatchObject({ path: installed.path, configured: true, changed: true });
    const repairedContent = readFileSync(repaired.path, "utf8");
    expect(repairedContent).toContain(`name: ${JSON.stringify(newUrl)}`);
    expect(repairedContent).not.toContain(oldUrl);
    expect(inspectDshPlugin(newOptions).configured).toBe(true);
    expect(inspectDshPlugin(oldOptions).configured).toBe(false);

    expect(installDshPlugin(newOptions)).toMatchObject({
      path: repaired.path, configured: true, changed: false,
    });
    expect(readFileSync(repaired.path, "utf8")).toBe(repairedContent);
  });

  it("installs a repeatable quoted overlay without changing existing DSH configuration", async () => {
    const f = await fixture();
    const entry = join(f.repository, "plugin ' $ special.js");
    writeFileSync(entry, "export function apply() {}\n");
    const options = { repository: f.repository, pluginEntry: entry };
    const installed = installDshPlugin(options);
    expect(installed.configured).toBe(true);
    expect(installDshPlugin(options).changed).toBe(false);
    expect(readFileSync(installed.path, "utf8")).toContain("file:");
    expect(inspectDshPlugin(options).configured).toBe(true);
    writeFileSync(installed.path, "# user's overlay\n");
    expect(() => installDshPlugin(options)).toThrow("unmanaged");
  });
});
