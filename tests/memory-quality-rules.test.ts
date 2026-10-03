import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { handleClaudeInteractiveHook } from "../src/integrations/claude/interactive-hook.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const running: RunningBridgeServer[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Fixture { root: string; dataDirectory: string; bridge: RunningBridgeServer }

async function fixture(): Promise<Fixture> {
  const root = createTestRepository("repomind-quality-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-quality-data-"));
  cleanup.push(root, dataDirectory);
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(root).database.close();
  const bridge = await startBridgeServer({ port: 0, dataDirectory });
  running.push(bridge);
  return { root, dataDirectory, bridge };
}

interface Tool { command: string; outcome: "pass" | "fail" | "interrupted" }

/** Replays one Claude task with real hook payload shapes. */
async function task(
  f: Fixture,
  id: string,
  prompt: string,
  tools: Tool[],
  summary: string,
  work?: () => void,
): Promise<Record<string, unknown> | null> {
  const hook = (input: Record<string, unknown>) => handleClaudeInteractiveHook({
    bridgeUrl: f.bridge.url,
    input: { session_id: id, cwd: f.root, ...input },
    onWarning: (warning) => { throw new Error(warning); },
  });
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  const started = await hook({ hook_event_name: "UserPromptSubmit", prompt });
  for (const [index, tool] of tools.entries()) {
    const common = { tool_name: "Bash", tool_use_id: `${id}-${index}`, tool_input: { command: tool.command } };
    await hook({ hook_event_name: "PreToolUse", ...common });
    if (tool.outcome === "fail") {
      await hook({ hook_event_name: "PostToolUseFailure", ...common, error: "Exit code 1\nFAILED" });
    } else {
      await hook({
        hook_event_name: "PostToolUse",
        ...common,
        tool_response: { stdout: `ok ${index}`, stderr: "", interrupted: tool.outcome === "interrupted", isImage: false },
      });
    }
  }
  work?.();
  await hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: summary });
  await hook({ hook_event_name: "SessionEnd", reason: "exit" });
  return started;
}

function inspect<T>(f: Fixture, read: (store: InteractiveActivityStore) => T): T {
  const store = new InteractiveActivityStore(f.root, f.dataDirectory);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function sessions(f: Fixture): string[] {
  return inspect(f, (store) => (store.core.context.database.raw
    .prepare("SELECT status FROM sessions ORDER BY started_at").all() as Array<{ status: string }>).map((row) => row.status));
}

function memories(f: Fixture): Array<{ id: string; type: string; title: string; status: string }> {
  return inspect(f, (store) => store.core.context.database.raw
    .prepare("SELECT id, type, title, status FROM memories ORDER BY created_at").all() as Array<{
      id: string; type: string; title: string; status: string;
    }>);
}

describe("rule 1: solutions need a repository outcome", () => {
  it("keeps a read-only answer as Evidence only", async () => {
    const f = await fixture();
    await task(f, "qa", "How is storage verified?", [{ command: "ls src", outcome: "pass" }], "Run the storage tests.");
    expect(sessions(f)).toEqual(["committed"]);
    expect(memories(f)).toEqual([]);
    const evidence = inspect(f, (store) => store.core.context.database.raw
      .prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='agent_summary'").get() as { count: number });
    expect(evidence.count).toBe(1);
  });

  it("does not extract recap decisions from a read-only answer", async () => {
    const f = await fixture();
    await task(f, "qa", "Recall the invoice fix", [{ command: "ls nonexistent", outcome: "fail" }],
      "发票金额已改为单价乘以数量，src/invoice 模块负责金额计算。");
    expect(memories(f)).toEqual([]);
  });

  it("preserves explicit commit extraction after read-only tool activity", async () => {
    const f = await fixture();
    inspect(f, (store) => {
      const common = { schemaVersion: 1, agent: "claude", agentSessionId: "explicit", repositoryPath: f.root } as const;
      const started = store.startTask({ ...common, eventId: "explicit-start", task: "Inspect the invoice design" });
      store.record({ ...common, eventId: "explicit-read", source: "claude-hook", type: "tool_result",
        payload: { toolName: "Read", toolInput: { file_path: "README.md" }, toolResponse: "Invoice calculation" } });
      store.core.commitSession({ sessionId: started.sessionId, idempotencyKey: "explicit-commit", status: "success",
        summary: "发票金额已改为单价乘以数量，src/invoice 模块负责金额计算。" });
      expect(store.core.context.database.raw.prepare("SELECT type FROM memories ORDER BY type").all())
        .toEqual([{ type: "architecture" }, { type: "decision" }, { type: "solution" }]);
    });
  });

  it("stores a solution when the task changed files", async () => {
    const f = await fixture();
    await task(f, "edit", "Fix the invoice rounding", [], "Fixed invoice rounding by using integer cents.", () => {
      writeFileSync(join(f.root, "invoice.js"), "export const cents = (value) => Math.round(value * 100);\n");
    });
    expect(memories(f)).toEqual([expect.objectContaining({
      type: "solution",
      title: "Fixed invoice rounding by using integer cents.",
    })]);
  });

  it("stores a solution when a test passed without file changes", async () => {
    const f = await fixture();
    await task(f, "verify", "Verify storage", [{ command: "npm test", outcome: "pass" }], "npm test passes.");
    expect(memories(f).map((memory) => memory.type).sort()).toEqual(["command", "solution"]);
  });

  it.each([
    ["要验证 storage 模块，就在项目根目录运行：\n\nnode --test storage.test.mjs", "Completed solution"],
    ["## Fixed rounding\nUsed integer cents.", "Completed solution"],
    ["```js\nconst x = 1;\n```\nSet x to one.", "Completed solution"],
    ["- Replaced the float math", "Completed solution"],
  ])("does not promote an incomplete opening or skip context for a title (%j)", async (summary, title) => {
    const f = await fixture();
    await task(f, "title", "Change something", [], summary, () => writeFileSync(join(f.root, "changed.txt"), "x\n"));
    expect(memories(f)).toEqual([expect.objectContaining({ type: "solution", title })]);
  });
});

describe("rule 2: a repeated passing command confirms its memory", () => {
  it("revalidates the existing memory instead of storing a duplicate", async () => {
    const f = await fixture();
    await task(f, "first", "Run storage tests", [{ command: "node --test storage.test.mjs", outcome: "pass" }], "Tests pass.", () => {
      writeFileSync(join(f.root, "storage.js"), "export const version = 1;\n");
    });
    const [original] = memories(f).filter((memory) => memory.type === "command");
    expect(original).toBeDefined();

    // A later edit makes the memory uncertain until something re-verifies it.
    writeFileSync(join(f.root, "storage.js"), "export const version = 2;\n");
    inspect(f, (store) => store.core.search("storage tests"));
    expect(memories(f).find((memory) => memory.id === original!.id)?.status).toBe("uncertain");

    await task(f, "second", "Run storage tests again", [
      { command: "ls && node --test storage.test.mjs 2>&1", outcome: "pass" },
    ], "Tests still pass.");

    const commands = memories(f).filter((memory) => memory.type === "command");
    expect(commands).toEqual([expect.objectContaining({ id: original!.id, status: "active" })]);
    const audit = inspect(f, (store) => store.core.context.database.raw.prepare(`
      SELECT action FROM memory_audit_log WHERE memory_id=? ORDER BY created_at
    `).all(original!.id) as Array<{ action: string }>);
    expect(audit.map((row) => row.action)).toContain("memory_revalidated");
    const links = inspect(f, (store) => store.core.context.database.raw
      .prepare("SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id=?").get(original!.id) as { count: number });
    expect(links.count).toBe(2);
  });
});

describe("rule 3: only unresolved verification makes a task partial", () => {
  it("ignores a failed exploratory command", async () => {
    const f = await fixture();
    await task(f, "explore", "Check storage", [
      { command: "cat package.json", outcome: "fail" },
      { command: "node --test storage.test.mjs", outcome: "pass" },
    ], "Storage tests pass.");
    expect(sessions(f)).toEqual(["committed"]);
  });

  it("lets a later passing run resolve an earlier failure of the same step", async () => {
    const f = await fixture();
    await task(f, "fixed", "Fix the tests", [
      { command: "npm test 2>&1 | tail -20", outcome: "fail" },
      { command: "cd . && npm test", outcome: "pass" },
    ], "Fixed the failing test.", () => writeFileSync(join(f.root, "fix.js"), "export {};\n"));
    expect(sessions(f)).toEqual(["committed"]);
  });

  it.each([
    [[{ command: "npm test", outcome: "fail" }]],
    [[{ command: "npm run build", outcome: "fail" }, { command: "npm test", outcome: "pass" }]],
    [[{ command: "npm test", outcome: "pass" }, { command: "npm test", outcome: "fail" }]],
    [[{ command: "npm test", outcome: "interrupted" }]],
  ] as Array<[Tool[]]>)("stays partial when verification did not end in a pass (%j)", async (tools) => {
    const f = await fixture();
    await task(f, "broken", "Run checks", tools, "Done.");
    expect(sessions(f)).toEqual(["partial"]);
    expect(memories(f)).toEqual([]);
  });
});

describe("rule 4: recall is recorded for audit", () => {
  it("records what each task start injected and lists it with the session", async () => {
    const f = await fixture();
    await task(f, "seed", "Run storage tests", [{ command: "node --test storage.test.mjs", outcome: "pass" }], "Storage tests pass.");
    const command = memories(f).find((memory) => memory.type === "command")!;

    const started = await task(f, "ask", "How do I verify storage tests?", [], "Run node --test storage.test.mjs.");
    const context = (started as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

    const listed = inspect(f, (store) => store.core.listSessions()) as Array<{ task: string; recall?: Record<string, unknown> }>;
    const asked = listed.find((session) => session.task === "How do I verify storage tests?");
    expect(asked?.recall).toMatchObject({
      memoryIds: expect.arrayContaining([command.id]),
      moduleIds: expect.any(Array),
      profileId: expect.toBeOneOf([null, expect.any(String)]),
      contextChars: context.length,
      truncated: false,
      stage: "generated", context, contextSha256: createHash("sha256").update(context).digest("hex"),
    });
    const seeded = listed.find((session) => session.task === "Run storage tests");
    expect(seeded?.recall).toMatchObject({ memoryIds: [], contextChars: 0 });
  });
});

describe("quality rule regression boundaries", () => {
  it.each([
    [[{ command: "npm test", outcome: "fail" }, { command: "npm test || true", outcome: "pass" }]],
    [[{ command: "npm test", outcome: "fail" }, { command: "npm test | tail", outcome: "pass" }]],
    [[{ command: "cd packages/a && npm test", outcome: "fail" }, { command: "cd packages/b && npm test", outcome: "pass" }]],
    [[{ command: "npm run build && npm test", outcome: "fail" }, { command: "npm test", outcome: "pass" }]],
  ] as Array<[Tool[]]>)("does not promote unresolved work after an unrelated or untrusted pass (%j)", async (tools) => {
    const f = await fixture();
    await task(f, "unsafe", "Fix and verify", tools, "Completed.", () => writeFileSync(join(f.root, "change.js"), "export {};"));
    expect(sessions(f)).toEqual(["partial"]);
    expect(memories(f)).toEqual([]);
  });

  it("ignores exploratory failures even when their arguments contain test", async () => {
    const f = await fixture();
    await task(f, "explore-test", "Explore", [{ command: "ls test", outcome: "fail" }], "No test directory.");
    expect(sessions(f)).toEqual(["committed"]);
    expect(memories(f)).toEqual([]);
  });

  it("keeps newly associated files searchable after revalidation", async () => {
    const f = await fixture();
    await task(f, "one", "Verify", [{ command: "npm test", outcome: "pass" }], "Passed.");
    const original = memories(f).find((memory) => memory.type === "command")!;
    await task(f, "two", "Verify", [{ command: "npm test", outcome: "pass" }], "Passed again.", () => {
      writeFileSync(join(f.root, "uniquebillinghandler.ts"), "export {};\n");
    });
    const matches = inspect(f, (store) => store.core.search("uniquebillinghandler"));
    expect(matches.map((memory) => memory.id)).toContain(original.id);
  });

  it("uses a conclusion or fallback instead of a dangling code-block lead-in", async () => {
    const f = await fixture();
    await task(f, "title-fence", "Verify", [{ command: "npm test", outcome: "pass" }],
      "运行：\n```sh\nnpm test\n```");
    expect(memories(f).find((memory) => memory.type === "solution")?.title).toBe("Completed solution");
  });

  it("audits actual truncated text and each subsequent recall", async () => {
    const f = await fixture();
    inspect(f, (store) => {
      for (let i = 0; i < 5; i++) store.core.record({ type: "solution", title: `quartz fact ${i}`, content: `quartz ${i} ` + "content ".repeat(1100) });
      const common = { schemaVersion: 1, agent: "claude", agentSessionId: "recall-audit", repositoryPath: f.root } as const;
      const started = store.startTask({ ...common, eventId: "audit-start", task: "quartz" });
      const record = (store.core.listSessions() as Array<{ recall: { memoryIds: string[]; context: string; truncated: boolean; entries: Array<{ truncated: boolean }> } }>)[0]!.recall;
      expect(record.truncated).toBe(true);
      expect(record.memoryIds.length).toBeLessThan(5);
      for (const id of record.memoryIds) expect(started.context).toContain(id);
      expect(record.entries.at(-1)?.truncated).toBe(true);
      expect(record.context).toBe(started.context);
      store.startTask({ ...common, eventId: "audit-start", task: "quartz" });
      store.startTask({ ...common, eventId: "audit-start", task: "quartz" });
      store.recall({ ...common, query: "quartz" });
      const audits = store.core.context.database.raw.prepare("SELECT payload_json FROM activity_events WHERE session_id=? AND json_extract(payload_json, '$.kind')='recall'").all(started.sessionId);
      expect(audits).toHaveLength(3);
      store.abort({ ...common, eventId: "audit-end", reason: "complete" });
    });
  });

  it("rejects completed start replays without orphaning a session or displacing current work", async () => {
    const f = await fixture();
    inspect(f, (store) => {
      const common = { schemaVersion: 1, agent: "claude", agentSessionId: "start-replay", repositoryPath: f.root } as const;
      const input = { ...common, eventId: "start-one", task: "Inspect" };
      store.startTask(input);
      store.finish({ ...common, eventId: "finish-one", summary: "Inspected." });
      expect(() => store.startTask(input)).toThrow(/completed or superseded/);
      expect(store.core.status()).toMatchObject({ openSessions: 0 });
      const second = store.startTask({ ...common, eventId: "start-two", task: "Continue" });
      expect(() => store.startTask(input)).toThrow(/completed or superseded/);
      const row = store.core.context.database.raw.prepare("SELECT current_session_id FROM agent_sessions").get();
      expect(row).toMatchObject({ current_session_id: second.sessionId });
      expect(store.core.listSessions()).toHaveLength(2);
      store.abort({ ...common, eventId: "abort-two", reason: "complete" });
    });
  });

  it("rolls back session creation if persisting the first activity fails", async () => {
    const f = await fixture();
    inspect(f, (store) => {
      store.core.context.database.raw.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
      expect(() => store.startTask({ schemaVersion: 1, agent: "claude", agentSessionId: "rollback", repositoryPath: f.root, eventId: "rollback-start", task: "Inspect" })).toThrow("injected failure");
      expect(store.core.listSessions()).toHaveLength(0);
      expect(store.core.context.database.raw.prepare("SELECT count(*) AS count FROM agent_sessions").get()).toMatchObject({ count: 0 });
    });
  });
});

it("redacts structured credentials before activity persistence", async () => {
  const f = await fixture();
  inspect(f, (store) => {
    const common = { schemaVersion: 1, agent: "claude", agentSessionId: "redaction", repositoryPath: f.root } as const;
    store.startTask({ ...common, eventId: "redaction-start", task: "Inspect" });
    const recorded = store.record({ ...common, eventId: "redaction-tool", source: "claude-hook", type: "tool_call",
      payload: { toolInput: { password: "synthetic-password", api_key: "synthetic-key" } } });
    expect(recorded.redactions).toBe(2);
    const row = store.core.context.database.raw.prepare("SELECT payload_json FROM activity_events WHERE id='redaction-tool'").get() as { payload_json: string };
    expect(row.payload_json).not.toContain("synthetic");
    expect(JSON.parse(row.payload_json).toolInput.password).toBe("[REDACTED:credential]");
    store.abort({ ...common, eventId: "redaction-end", reason: "complete" });
  });
});
