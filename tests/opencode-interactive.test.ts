import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { createOpenCodeInteractivePlugin } from "../src/integrations/opencode/interactive-plugin.js";
import {
  inspectOpenCodeInteractivePlugin,
  installOpenCodeInteractivePlugin,
} from "../src/integrations/opencode/plugin-installer.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const running: RunningBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function initializedFixture(): { repository: string; dataDirectory: string } {
  const repository = createTestRepository("repomind-opencode-interactive-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-opencode-interactive-data-"));
  cleanup.push(repository, dataDirectory);
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    initializeRepository(repository).database.close();
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
  return { repository, dataDirectory };
}

function userMessage(sessionID: string, messageID: string, text: string) {
  return {
    message: { id: messageID, sessionID, role: "user" },
    parts: [{ id: `${messageID}-text`, sessionID, messageID, type: "text", text }],
  };
}

describe("OpenCode transparent interactive integration", () => {
  it("injects prior memory and commits root-session activity without MCP calls", async () => {
    const fixture = initializedFixture();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    const assistantBySession = new Map<string, string>();
    const warnings: string[] = [];
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: path.id === "grandchild-1"
            ? { id: path.id, parentID: "child-1" }
            : path.id.startsWith("child-")
              ? { id: path.id, parentID: "root-1" }
              : { id: path.id },
        }),
        messages: async ({ path }: { path: { id: string } }) => ({
          data: [{
            info: { id: `${path.id}-assistant`, sessionID: path.id, role: "assistant" },
            parts: [{
              id: `${path.id}-assistant-text`,
              sessionID: path.id,
              messageID: `${path.id}-assistant`,
              type: "text",
              text: assistantBySession.get(path.id) ?? "",
            }],
          }],
        }),
        app: undefined,
      },
      app: { log: async () => ({}) },
    };
    const plugin = await createOpenCodeInteractivePlugin({
      bridgeUrl: bridge.url,
      onWarning: (warning) => warnings.push(warning),
    })({ client, directory: fixture.repository, worktree: fixture.repository });
    const config = { mcp: { repomind: { type: "local", enabled: true } } };
    await plugin.config(config);
    expect(config.mcp.repomind.enabled).toBe(false);

    const first = userMessage("root-1", "message-1", "Document the invoice verification command");
    await plugin["chat.message"]({ sessionID: "root-1", messageID: "message-1" }, first);
    const firstMessages = [{ info: first.message, parts: [...first.parts] }];
    await plugin["experimental.chat.messages.transform"]({}, { messages: firstMessages });
    expect(firstMessages[0]!.parts).toHaveLength(1);

    const child = userMessage("child-1", "child-message-1", "Explore the repository");
    await plugin["chat.message"]({ sessionID: "child-1", messageID: "child-message-1" }, child);

    writeFileSync(join(fixture.repository, "README.txt"), "Run npm test -- invoice\n", "utf8");
    await plugin["tool.execute.before"](
      { tool: "shell", sessionID: "grandchild-1", callID: "call-1" },
      { args: { command: "npm test -- invoice" } },
    );
    await plugin["tool.execute.after"](
      { tool: "shell", sessionID: "grandchild-1", callID: "call-1", args: { command: "npm test -- invoice" } },
      { title: "Run tests", output: "Tests: 1 passed", metadata: { exit: 0 } },
    );
    await plugin.event({ event: {
      type: "message.part.updated",
      properties: { part: {
        sessionID: "child-1",
        callID: "call-failure",
        tool: "read",
        state: { status: "error", input: { filePath: "missing.txt" }, error: "File not found" },
      } },
    } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "grandchild-1" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-1" } } });
    await plugin.event({ event: {
      type: "session.deleted",
      properties: { info: { id: "child-1", parentID: "root-1" } },
    } });
    const openCore = new RepositoryMemoryCore(fixture.repository, { dataDirectory: fixture.dataDirectory });
    try {
      expect(openCore.context.database.raw.prepare(
        "SELECT status FROM sessions WHERE client_session_id='root-1'",
      ).get()).toEqual({ status: "open" });
    } finally {
      openCore.close();
    }
    assistantBySession.set("root-1", "Documented npm test -- invoice as the verification command.");
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "root-1" } } });

    const second = userMessage("root-2", "message-2", "Which invoice verification command should I run?");
    await plugin["chat.message"]({ sessionID: "root-2", messageID: "message-2" }, second);
    const secondMessages = [{ info: second.message, parts: [...second.parts] }];
    await plugin["experimental.chat.messages.transform"]({}, { messages: secondMessages });
    expect(secondMessages[0]!.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        synthetic: true,
        text: expect.stringContaining("npm test -- invoice"),
      }),
    ]));

    const core = new RepositoryMemoryCore(fixture.repository, { dataDirectory: fixture.dataDirectory });
    try {
      const session = core.context.database.raw.prepare(
        "SELECT client_name,status FROM sessions WHERE client_session_id='root-1'",
      ).get();
      expect(session).toEqual({ client_name: "opencode-interactive", status: "committed" });
      const rows = core.context.database.raw.prepare(`
        SELECT source,event_type,COUNT(*) AS count FROM activity_events
        WHERE source='opencode-plugin' GROUP BY source,event_type ORDER BY event_type
      `).all();
      expect(rows).toEqual([
        { source: "opencode-plugin", event_type: "assistant_message", count: 1 },
        { source: "opencode-plugin", event_type: "session_event", count: 1 },
        { source: "opencode-plugin", event_type: "tool_call", count: 1 },
        { source: "opencode-plugin", event_type: "tool_failure", count: 1 },
        { source: "opencode-plugin", event_type: "tool_result", count: 1 },
        { source: "opencode-plugin", event_type: "user_message", count: 2 },
      ]);
      const delegated = core.context.database.raw.prepare(`
        SELECT event_type,payload_json FROM activity_events
        WHERE event_type IN ('tool_call','tool_result','tool_failure')
        ORDER BY event_type
      `).all() as Array<{ event_type: string; payload_json: string }>;
      expect(delegated.map((row) => ({
        eventType: row.event_type,
        originSessionId: JSON.parse(row.payload_json).originSessionId,
      }))).toEqual([
        { eventType: "tool_call", originSessionId: "grandchild-1" },
        { eventType: "tool_failure", originSessionId: "child-1" },
        { eventType: "tool_result", originSessionId: "grandchild-1" },
      ]);
      const tests = core.context.database.raw.prepare(`
        SELECT metadata_json FROM evidence e
        JOIN sessions s ON s.id=e.session_id
        WHERE s.client_session_id='root-1' AND e.kind='test_result'
      `).all() as Array<{ metadata_json: string }>;
      expect(tests.map((row) => JSON.parse(row.metadata_json))).toEqual([
        { command: "npm test -- invoice", exitCode: 0 },
      ]);
      const childSessions = core.context.database.raw.prepare(
        "SELECT COUNT(*) AS count FROM agent_sessions WHERE external_session_id IN ('child-1','grandchild-1')",
      ).get();
      expect(childSessions).toEqual({ count: 0 });
    } finally {
      core.close();
    }
    expect(warnings).toEqual([]);

    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "root-2" } } } });
  });

  it("installs an idempotent managed project plugin without replacing user code", () => {
    const repository = createTestRepository("repomind-opencode-plugin-install-");
    const scratch = mkdtempSync(join(tmpdir(), "repomind-opencode-plugin-entry-"));
    cleanup.push(repository, scratch);
    const entry = join(scratch, "interactive-plugin.js");
    writeFileSync(entry, "export async function RepoMindOpenCodePlugin() { return {}; }\n", "utf8");

    const first = installOpenCodeInteractivePlugin({ repository, pluginEntry: entry });
    const second = installOpenCodeInteractivePlugin({ repository, pluginEntry: entry });
    expect(first).toMatchObject({ installed: true, changed: true });
    expect(second).toMatchObject({ installed: true, changed: false });
    expect(readFileSync(first.path, "utf8")).toContain("RepoMindOpenCodePlugin");
    expect(inspectOpenCodeInteractivePlugin({ repository, pluginEntry: entry })).toMatchObject({
      installed: true,
      managed: true,
      configured: true,
    });
    const movedEntry = join(scratch, "moved-interactive-plugin.js");
    writeFileSync(movedEntry, "export async function RepoMindOpenCodePlugin() { return {}; }\n", "utf8");
    expect(installOpenCodeInteractivePlugin({ repository, pluginEntry: movedEntry }))
      .toMatchObject({ installed: true, changed: true, pluginEntry: movedEntry });
    expect(inspectOpenCodeInteractivePlugin({ repository, pluginEntry: movedEntry }).configured).toBe(true);

    const otherRepository = createTestRepository("repomind-opencode-plugin-user-");
    cleanup.push(otherRepository);
    const userPlugin = join(otherRepository, ".opencode", "plugins", "repomind.js");
    mkdirSync(join(otherRepository, ".opencode", "plugins"), { recursive: true });
    writeFileSync(userPlugin, "export const UserPlugin = async () => ({});\n", "utf8");
    expect(() => installOpenCodeInteractivePlugin({ repository: otherRepository, pluginEntry: entry }))
      .toThrow(/Refusing to replace an unmanaged OpenCode plugin/u);
  });
});
