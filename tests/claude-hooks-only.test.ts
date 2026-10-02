import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectClaudeInteractiveHooks,
  installClaudeInteractiveHooks,
  isRepoMindManagedProxyUrl,
} from "../src/integrations/claude/hook-installer.js";
import { claudeInteractiveStatus } from "../src/integrations/claude/interactive-setup.js";
import { handleClaudeInteractiveHook } from "../src/integrations/claude/interactive-hook.js";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const running: RunningBridgeServer[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repository(settings?: unknown): { root: string; settingsPath: string; dataDirectory: string } {
  const root = createTestRepository("repomind-claude-hooks-only-");
  const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-claude-hooks-only-data-"));
  cleanup.push(root, dataDirectory);
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(root).database.close();
  const settingsPath = join(root, ".claude", "settings.local.json");
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
  }
  return { root, settingsPath, dataDirectory };
}

function readSettings(path: string): Record<string, unknown> & { env?: Record<string, string> } {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { env?: Record<string, string> };
}

const cliEntry = join(process.cwd(), "dist", "cli", "entry.js");
const LEGACY_ROUTE = "http://127.0.0.1:8096/claude-code/default";

describe("hooks-only Claude integration", () => {
  it.each([
    [LEGACY_ROUTE, true],
    ["http://localhost:8096/claude-code/team-a", true],
    ["http://[::1]:8096/claude-code", true],
    ["  HTTP://127.0.0.1:8096/Claude-Code/default  ", true],
    ["http://127.0.0.1:8097/claude-code/default", false],
    ["http://127.0.0.1:8096/v1", false],
    ["http://127.0.0.1:8096/claude-codex", false],
    ["https://relay.example.com:8096/claude-code/default", false],
    ["https://api.anthropic.com", false],
    [null, false],
  ])("recognizes RepoMind-managed MemoryProxy routes (%s -> %s)", (value, expected) => {
    expect(isRepoMindManagedProxyUrl(value)).toBe(expected);
  });

  it("removes the legacy MemoryProxy route while preserving other settings", () => {
    const fixture = repository({
      env: { ANTHROPIC_BASE_URL: LEGACY_ROUTE, OTHER_SETTING: "kept" },
      permissions: { allow: ["Bash(npm test)"] },
    });

    const first = installClaudeInteractiveHooks({ repository: fixture.root, cliEntry });
    expect(first.added).toBe(7);
    expect(first.proxyEnvironment).toEqual({
      configured: true,
      value: null,
      expected: null,
      legacyManagedProxy: false,
      changed: true,
      removed: LEGACY_ROUTE,
    });
    const settings = readSettings(fixture.settingsPath);
    expect(settings.env).toEqual({ OTHER_SETTING: "kept" });
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });

    const second = installClaudeInteractiveHooks({ repository: fixture.root, cliEntry });
    expect(second).toMatchObject({ added: 0, unchanged: 7, proxyEnvironment: { changed: false, removed: null } });
    expect(inspectClaudeInteractiveHooks({ repository: fixture.root, cliEntry })).toMatchObject({
      installed: 7,
      expected: 7,
      proxyEnvironment: { configured: true, value: null, legacyManagedProxy: false },
    });
  });

  it("drops an env block that only held the legacy route", () => {
    const fixture = repository({ env: { ANTHROPIC_BASE_URL: LEGACY_ROUTE } });
    installClaudeInteractiveHooks({ repository: fixture.root, cliEntry });
    expect(readSettings(fixture.settingsPath)).not.toHaveProperty("env");
  });

  it("never touches a user-chosen endpoint", () => {
    const relay = "https://relay.example.com/anthropic";
    const fixture = repository({ env: { ANTHROPIC_BASE_URL: relay } });
    const result = installClaudeInteractiveHooks({ repository: fixture.root, cliEntry });
    expect(result.proxyEnvironment).toMatchObject({ configured: true, changed: false, removed: null, value: relay });
    expect(readSettings(fixture.settingsPath).env).toEqual({ ANTHROPIC_BASE_URL: relay });
  });

  it("still writes an explicitly requested proxy route", () => {
    const fixture = repository({ env: { ANTHROPIC_BASE_URL: "https://old.example.invalid" } });
    const result = installClaudeInteractiveHooks({ repository: fixture.root, cliEntry, proxyUrl: LEGACY_ROUTE });
    expect(result.proxyEnvironment).toMatchObject({
      configured: true,
      changed: true,
      removed: null,
      value: LEGACY_ROUTE,
      expected: LEGACY_ROUTE,
      legacyManagedProxy: true,
    });
    expect(inspectClaudeInteractiveHooks({ repository: fixture.root, cliEntry }).proxyEnvironment)
      .toMatchObject({ configured: false, legacyManagedProxy: true });
  });

  it("does not require MemoryProxy in hooks-only status and flags a legacy route", async () => {
    const fixture = repository({ env: { ANTHROPIC_BASE_URL: LEGACY_ROUTE } });
    installClaudeInteractiveHooks({ repository: fixture.root, cliEntry, proxyUrl: LEGACY_ROUTE });
    const options = {
      repository: fixture.root,
      cliEntry,
      repoMindRoot: resolve("."),
      dataDirectory: fixture.dataDirectory,
      runnerExecutable: join(fixture.dataDirectory, "missing-claude"),
    };

    const status = await claudeInteractiveStatus(options);
    expect(status.warnings).toEqual([expect.stringMatching(/legacy MemoryProxy route/u)]);
    expect(status.nextSteps).toContainEqual(expect.stringMatching(/repair Claude hooks and model routing/u));
    expect(status.nextSteps.join("\n")).not.toMatch(/MemoryProxy|services start/u);

    const proxied = await claudeInteractiveStatus({ ...options, proxyUrl: LEGACY_ROUTE });
    expect(proxied.warnings).toEqual([]);
    expect(proxied.nextSteps).toContainEqual(expect.stringMatching(/start MemoryProxy/u));
  });
});

describe("Claude hook sessions without MemoryProxy", () => {
  async function session(
    fixture: { root: string; dataDirectory: string },
    bridge: RunningBridgeServer,
    id: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    event: "PostToolUse" | "PostToolUseFailure" = "PostToolUse",
  ): Promise<string[]> {
    const warnings: string[] = [];
    const hook = (input: Record<string, unknown>) => handleClaudeInteractiveHook({
      bridgeUrl: bridge.url,
      input: { session_id: id, cwd: fixture.root, ...input },
      onWarning: (warning) => warnings.push(warning),
    });
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Run npm test to verify the invoice module" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${id}-t1`, tool_input: toolInput });
    await hook({
      hook_event_name: event,
      tool_name: "Bash",
      tool_use_id: `${id}-t1`,
      tool_input: toolInput,
      ...(event === "PostToolUse" ? { tool_response: toolResponse } : { error: "Exit code 1\nFAIL" }),
    });
    await hook({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Ran npm test for the invoice module.",
    });
    await hook({ hook_event_name: "SessionEnd", reason: "exit" });
    return warnings;
  }

  function outcome(fixture: { root: string; dataDirectory: string }) {
    const store = new InteractiveActivityStore(fixture.root, fixture.dataDirectory);
    try {
      const db = store.core.context.database.raw;
      return {
        sessions: (db.prepare("SELECT status FROM sessions").all() as Array<{ status: string }>).map((row) => row.status),
        memories: db.prepare("SELECT type, content FROM memories").all() as Array<{ type: string; content: string }>,
        sources: (db.prepare("SELECT DISTINCT source FROM activity_events").all() as Array<{ source: string }>)
          .map((row) => row.source),
      };
    } finally {
      store.close();
    }
  }

  const passed = { stdout: "invoice tests passed", stderr: "", interrupted: false, isImage: false };

  it("commits a completed foreground Bash test as verified and recalls it next session", async () => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);

    expect(await session(fixture, bridge, "claude-1", { command: "npm test" }, passed)).toEqual([]);
    const first = outcome(fixture);
    expect(first.sessions).toEqual(["committed"]);
    expect(first.sources).toEqual(["claude-hook"]);
    expect(first.memories).toContainEqual(expect.objectContaining({
      type: "command",
      content: expect.stringContaining("npm test"),
    }));

    const recalled = await handleClaudeInteractiveHook({
      bridgeUrl: bridge.url,
      input: {
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-2",
        cwd: fixture.root,
        prompt: "How do I verify the invoice module?",
      },
    });
    expect(recalled).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("npm test") },
    });
  });

  it("treats Node's built-in test runner as a verified test command", async () => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    await session(fixture, bridge, "claude-node-test", { command: "node --test storage.test.mjs" }, passed);
    const result = outcome(fixture);
    expect(result.sessions).toEqual(["committed"]);
    expect(result.memories).toContainEqual(expect.objectContaining({
      type: "command",
      content: expect.stringContaining("node --test storage.test.mjs"),
    }));
  });

  it("stores only the test invocation and keeps the full command line as provenance", async () => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    const invoked = "ls src && cat storage.test.mjs && node --test storage.test.mjs";
    await session(fixture, bridge, "claude-compound", { command: invoked }, passed);
    await session(fixture, bridge, "claude-plain", { command: "node --test storage.test.mjs" }, passed);

    const store = new InteractiveActivityStore(fixture.root, fixture.dataDirectory);
    try {
      const db = store.core.context.database.raw;
      const titles = (db.prepare("SELECT title FROM memories WHERE type='command'").all() as Array<{ title: string }>)
        .map((row) => row.title);
      expect(new Set(titles)).toEqual(new Set(["Verified command: node --test storage.test.mjs"]));
      const evidence = db.prepare("SELECT content FROM evidence WHERE kind='test_result' ORDER BY created_at").all() as Array<{
        content: string;
      }>;
      expect(JSON.parse(evidence[0]!.content)).toMatchObject({ command: "node --test storage.test.mjs", invokedAs: invoked });
      expect(JSON.parse(evidence[1]!.content)).not.toHaveProperty("invokedAs");
    } finally {
      store.close();
    }
  });

  it("commits a piped test run without claiming the test was verified", async () => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    await session(fixture, bridge, "claude-piped", { command: "node --test storage.test.mjs 2>&1 | tail -30" }, passed);
    const result = outcome(fixture);
    expect(result.sessions).toEqual(["committed"]);
    expect(result.memories.filter((memory) => memory.type === "command")).toEqual([]);
    expect(result.memories).toContainEqual(expect.objectContaining({ type: "solution" }));
  });

  it.each([
    { name: "interrupted", input: { command: "npm test" }, response: { ...passed, interrupted: true } },
    { name: "background", input: { command: "npm test", run_in_background: true }, response: { backgroundTaskId: "b1" } },
  ])("keeps an $name Bash result unverified", async ({ input, response }) => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    await session(fixture, bridge, "claude-unknown", input, response);
    const result = outcome(fixture);
    expect(result.sessions).toEqual(["partial"]);
    expect(result.memories.filter((memory) => memory.type === "command")).toEqual([]);
  });

  it("records a failing Bash test as a failure, not a verified command", async () => {
    const fixture = repository();
    const bridge = await startBridgeServer({ port: 0, dataDirectory: fixture.dataDirectory });
    running.push(bridge);
    await session(fixture, bridge, "claude-fail", { command: "npm test" }, {}, "PostToolUseFailure");
    const result = outcome(fixture);
    expect(result.sessions).toEqual(["partial"]);
    expect(result.memories.filter((memory) => memory.type === "command")).toEqual([]);
  });
});
