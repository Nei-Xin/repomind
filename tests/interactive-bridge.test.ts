import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { handleClaudeInteractiveHook } from "../src/integrations/claude/interactive-hook.js";
import { installClaudeInteractiveHooks } from "../src/integrations/claude/hook-installer.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const running: RunningBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function initializedFixture(): { repository: string; dataDirectory: string } {
  const repository = createTestRepository("repomind-interactive-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-interactive-data-"));
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

async function post<T>(base: string, path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T;
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

describe("interactive RepoMind Bridge", () => {
  it("captures L0 activity, commits Git/test evidence, and recalls it in a later Claude session", async () => {
    const fixture = initializedFixture();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory, token: "test-token" });
    running.push(bridge);
    const common = {
      schemaVersion: 1,
      agent: "claude",
      agentSessionId: "claude-session-1",
      repositoryPath: fixture.repository,
    } as const;

    const unauthorized = await fetch(`${bridge.url}/health`);
    expect(unauthorized.status).toBe(401);
    const health = await fetch(`${bridge.url}/health`, { headers: { authorization: "Bearer test-token" } });
    expect(await health.json()).toEqual({ status: "ok", schemaVersion: 1 });

    const started = await post<{
      sessionId: string;
      recalled: { memories: number };
      context: string;
    }>(bridge.url, "/v1/tasks/start", {
      ...common,
      eventId: "hook:start:1",
      task: "Fix invoice decimal arithmetic",
    }, "test-token");
    expect(started.recalled.memories).toBe(0);
    expect(started.context).toBe("");

    writeFileSync(join(fixture.repository, "README.txt"), "invoice arithmetic uses Decimal\n", "utf8");
    const activity = {
      ...common,
      eventId: "hook:tool-result:1",
      source: "claude-hook",
      type: "tool_result",
      timestamp: 1_800_000_000_000,
      payload: {
        toolName: "Bash",
        toolInput: { command: "npm test -- invoice" },
        toolResponse: { stdout: "Tests: 4 passed", exitCode: 0 },
      },
    } as const;
    const firstActivity = await post<{ stored: boolean }>(bridge.url, "/v1/activities", activity, "test-token");
    expect(firstActivity.stored).toBe(true);
    const duplicateActivity = await post<{ stored: boolean }>(bridge.url, "/v1/activities", {
      ...activity,
      timestamp: 1_800_000_000_100,
    }, "test-token");
    expect(duplicateActivity.stored).toBe(false);

    await post(bridge.url, "/v1/activities", {
      ...common,
      eventId: "proxy:turn:1:assistant",
      source: "memory-proxy",
      type: "assistant_message",
      payload: { text: `Implemented Decimal arithmetic; secret=sk-${"a".repeat(24)}` },
    }, "test-token");
    const finished = await post<{
      status: string;
      evidenceCreated: number;
      memories: { stored: number };
      tests: number;
      maintenance: {
        status: string;
        l2: { status: string; result: { created: number } | null };
        l3: { status: string; result: { created: boolean } | null };
      } | null;
    }>(bridge.url, "/v1/tasks/finish", {
      ...common,
      eventId: "hook:finish:1",
      summary: "Invoice arithmetic now uses Decimal and the invoice tests pass.",
    }, "test-token");
    expect(finished.status).toBe("committed");
    expect(finished.tests).toBe(1);
    expect(finished.evidenceCreated).toBeGreaterThanOrEqual(4);
    expect(finished.memories.stored).toBeGreaterThanOrEqual(2);
    expect(finished.maintenance?.status).toBe("success");
    expect(finished.maintenance?.l2.status).toBe("success");
    expect(finished.maintenance?.l2.result?.created).toBeGreaterThan(0);
    expect(finished.maintenance?.l3.status).toBe("success");
    expect(finished.maintenance?.l3.result?.created).toBe(true);

    const core = new RepositoryMemoryCore(fixture.repository, { dataDirectory: fixture.dataDirectory });
    try {
      expect(core.context.database.raw.prepare(
        "SELECT status FROM sessions WHERE id=?",
      ).get(started.sessionId)).toEqual({ status: "committed" });
      const activityPayload = core.context.database.raw.prepare(
        "SELECT payload_json FROM activity_events WHERE id='proxy:turn:1:assistant'",
      ).get() as { payload_json: string };
      expect(activityPayload.payload_json).toContain("[REDACTED:api-key]");
      expect(activityPayload.payload_json).not.toContain(`sk-${"a".repeat(24)}`);
      expect(core.status()).toMatchObject({ moduleNarratives: 1, repositoryProfiles: 1 });
    } finally {
      core.close();
    }

    const recalled = await post<{ context: string; recalled: { memories: number } }>(bridge.url, "/v1/tasks/start", {
      schemaVersion: 1,
      agent: "claude",
      agentSessionId: "claude-session-2",
      repositoryPath: fixture.repository,
      eventId: "hook:start:2",
      task: "Extend invoice Decimal arithmetic",
    }, "test-token");
    expect(recalled.recalled.memories).toBeGreaterThan(0);
    expect(recalled.context).toContain("Invoice arithmetic now uses Decimal");

    const aborted = await post<{ status: string }>(bridge.url, "/v1/tasks/abort", {
      schemaVersion: 1,
      agent: "claude",
      agentSessionId: "claude-session-2",
      repositoryPath: fixture.repository,
      eventId: "hook:abort:2",
      reason: "test cleanup",
    }, "test-token");
    expect(aborted.status).toBe("abandoned");
  });

  it("drives the lifecycle through Claude hook events without MCP calls", async () => {
    const fixture = initializedFixture();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    const warnings: string[] = [];
    const hook = (input: unknown) => handleClaudeInteractiveHook({
      bridgeUrl: bridge.url,
      input,
      onWarning: (warning) => warnings.push(warning),
    });

    await hook({ hook_event_name: "SessionStart", session_id: "hook-session-1", cwd: fixture.repository });
    await hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "hook-session-1",
      cwd: fixture.repository,
      prompt: "Document the invoice verification command",
      hook_event_id: "prompt-1",
    });
    writeFileSync(join(fixture.repository, "README.txt"), "Run npm test -- invoice\n", "utf8");
    await hook({
      hook_event_name: "PostToolUse",
      session_id: "hook-session-1",
      cwd: fixture.repository,
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: { command: "npm test -- invoice" },
      tool_response: { stdout: "Tests: 1 passed", exitCode: 0 },
    });
    await hook({
      hook_event_name: "Stop",
      session_id: "hook-session-1",
      cwd: fixture.repository,
      hook_event_id: "stop-1",
      last_assistant_message: "Documented the invoice verification command.",
    });

    const second = await hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "hook-session-2",
      cwd: fixture.repository,
      prompt: "Which invoice verification command should I run?",
      hook_event_id: "prompt-2",
    });
    expect(second).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("npm test -- invoice"),
      },
    });
    expect(warnings).toEqual([]);

    await hook({
      hook_event_name: "SessionEnd",
      session_id: "hook-session-2",
      cwd: fixture.repository,
      hook_event_id: "end-2",
      reason: "user_exit",
    });
  });

  it("keeps the interactive task committed when L2/L3 maintenance fails", async () => {
    const fixture = initializedFixture();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    const rebuild = vi.spyOn(RepositoryMemoryCore.prototype, "rebuildModuleNarratives")
      .mockImplementationOnce(() => { throw new Error("Injected interactive L2 failure"); });
    try {
      const common = {
        schemaVersion: 1,
        agent: "claude",
        agentSessionId: "claude-session-maintenance-failure",
        repositoryPath: fixture.repository,
      } as const;
      await post(bridge.url, "/v1/tasks/start", {
        ...common,
        eventId: "hook:start:maintenance-failure",
        task: "Record a successful task despite derived maintenance failure",
      });
      const finished = await post<{
        status: string;
        maintenance: {
          status: string;
          l2: { status: string; error: { code: string; message: string } | null };
          l3: { status: string };
        } | null;
      }>(bridge.url, "/v1/tasks/finish", {
        ...common,
        eventId: "hook:finish:maintenance-failure",
        summary: "The task completed even though derived maintenance failed.",
      });
      expect(finished.status).toBe("committed");
      expect(finished.maintenance).toMatchObject({
        status: "failed",
        l2: { status: "failed", error: { code: "INTERNAL_ERROR", message: "Injected interactive L2 failure" } },
        l3: { status: "skipped" },
      });
    } finally {
      rebuild.mockRestore();
    }
  });

  it("merges idempotent Claude hook definitions without replacing existing settings", () => {
    const fixture = initializedFixture();
    const settingsPath = join(fixture.repository, ".claude", "settings.local.json");
    mkdirSync(join(fixture.repository, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["PowerShell(npm run *)"] } }), "utf8");
    const first = installClaudeInteractiveHooks({
      repository: fixture.repository,
      cliEntry: join(process.cwd(), "dist", "cli", "entry.js"),
      bridgeUrl: "http://127.0.0.1:7345",
    });
    const second = installClaudeInteractiveHooks({
      repository: fixture.repository,
      cliEntry: join(process.cwd(), "dist", "cli", "entry.js"),
      bridgeUrl: "http://127.0.0.1:7345",
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
      hooks: Record<string, unknown[]>;
    };
    expect(first.added).toBe(7);
    expect(second).toMatchObject({ added: 0, unchanged: 7 });
    expect(settings.permissions.allow).toEqual(["PowerShell(npm run *)"]);
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ].sort());
  });
});
