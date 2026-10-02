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
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
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

