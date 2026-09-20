import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { parseCommitInput } from "../src/cli/commit-input.js";
import { commitHostLifecycle } from "../src/integrations/opencode/lifecycle.js";
import { createMcpServer } from "../src/mcp/server.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("command verification provenance", () => {
  let repository: string;
  let data: string;
  let core: RepositoryMemoryCore;
  let previousDataDirectory: string | undefined;

  beforeEach(() => {
    previousDataDirectory = process.env.REPOMIND_DATA_DIR;
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-provenance-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
    core = new RepositoryMemoryCore(repository);
  });

  afterEach(() => {
    core.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    if (previousDataDirectory === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previousDataDirectory;
  });

  function input() {
    return {
      sessionId: core.startSession({ task: "Check the repository tests" }).sessionId,
      idempotencyKey: "test-result",
      status: "success" as const,
      summary: "Tests passed.",
      tests: [{ command: "npm test", exitCode: 0, summary: "4 tests passed" }],
    };
  }

  function metadata(sessionId: string): Record<string, unknown> {
    const row = core.context.database.raw.prepare(
      "SELECT metadata_json FROM evidence WHERE session_id=? AND kind='test_result'",
    ).get(sessionId) as { metadata_json: string };
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  }

  it("treats CLI results as reports and rejects payloads claiming collector provenance", () => {
    const submitted = input();
    core.commitSession(parseCommitInput(submitted));
    const command = core.search("npm test", { types: ["command"] })[0]!;
    expect(command).toMatchObject({ title: "Reported successful command: npm test", confidence: 0.5 });
    expect(command.tags).toContain("reported-command");
    expect(command.tags).not.toContain("verified-command");
    expect(command.content).toContain("Result: reported passed");
    expect(metadata(submitted.sessionId)).toMatchObject({ verificationSource: "caller-reported" });
    expect(() => parseCommitInput({ ...submitted, sources: { tests: "host-verified" } })).toThrow();
    expect(() => parseCommitInput({
      ...submitted, tests: [{ ...submitted.tests[0], verificationSource: "host-verified" }],
    })).toThrow();
  });

  it("does not let an MCP caller self-assign host verification", async () => {
    const submitted = input();
    const server = createMcpServer();
    const client = new Client({ name: "provenance-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({ name: "repo_session_commit", arguments: {
        repo_path: repository,
        session_id: submitted.sessionId,
        idempotency_key: submitted.idempotencyKey,
        status: "success",
        summary: submitted.summary,
        sources: { tests: "host-verified" },
        tests: [{ command: "npm test", exit_code: 0, summary: "4 tests passed", verificationSource: "host-verified" }],
      } });
      expect(response.isError).not.toBe(true);
      expect(core.search("npm test", { types: ["command"] })[0])
        .toMatchObject({ title: "Reported successful command: npm test", tags: ["test", "reported-command", "caller-reported"] });
      expect(metadata(submitted.sessionId)).toMatchObject({ verificationSource: "caller-reported" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps Host verification distinct from an earlier report of the same command", () => {
    const reported = input();
    core.commitSession(reported);
    const verified = input();
    commitHostLifecycle({ repository, ...verified });
    const commands = core.search("npm test", { types: ["command"] });
    expect(commands).toHaveLength(2);
    expect(commands.find((command) => command.tags.includes("host-verified")))
      .toMatchObject({ title: "Verified command: npm test", confidence: 0.95 });
    expect(metadata(verified.sessionId)).toMatchObject({ verificationSource: "host-verified" });
    // Changing the provenance on a retry must not silently upgrade old evidence.
    expect(() => core.commitSession(reported, { tests: "host-verified" })).toThrow(/Idempotency key/);
  });

  it("marks captured tool results as observed rather than Host verification", () => {
    const store = new InteractiveActivityStore(repository, data);
    try {
      const common = { schemaVersion: 1, agent: "opencode", agentSessionId: "observed", repositoryPath: repository } as const;
      const started = store.startTask({ ...common, eventId: "start", task: "Run repository tests" });
      store.record({ ...common, eventId: "result", source: "opencode-plugin", type: "tool_result", payload: {
        toolName: "bash", toolInput: { command: "npm test" }, toolResponse: { exitCode: 0, output: "4 tests passed" },
      } });
      store.finish({ ...common, eventId: "finish", summary: "Tests passed." });
      expect(metadata(started.sessionId)).toMatchObject({ verificationSource: "tool-observed" });
      const command = core.search("npm test", { types: ["command"] })[0]!;
      expect(command.tags).toContain("verified-command");
      expect(command.tags).toContain("tool-observed");
      expect(command.tags).not.toContain("host-verified");
      expect(command.confidence).toBe(0.9);
    } finally {
      store.close();
    }
  });

  it("replays a pre-provenance receipt without upgrading its evidence", () => {
    const submitted = input();
    const receipt = core.commitSession(submitted);
    core.context.database.raw.prepare(`
      UPDATE evidence SET metadata_json=json_remove(metadata_json, '$.verificationSource')
      WHERE session_id=? AND kind='test_result'
    `).run(submitted.sessionId);
    const evidenceBefore = core.context.database.raw.prepare("SELECT * FROM evidence WHERE session_id=?")
      .all(submitted.sessionId);
    expect(core.commitSession(submitted, { tests: "host-verified" })).toEqual(receipt);
    expect(metadata(submitted.sessionId).verificationSource).toBeUndefined();
    expect(core.context.database.raw.prepare("SELECT * FROM evidence WHERE session_id=?").all(submitted.sessionId))
      .toEqual(evidenceBefore);
  });

  it("warns about legacy labels without rewriting history or recalling them through derived layers", () => {
    core.record({ type: "architecture", title: "Storage boundary", content: "SQLite owns repository memory.", confidence: 0.9 });
    const submitted = input();
    writeFileSync(join(repository, "README.txt"), "Changed during test execution.\n");
    core.commitSession(submitted, { tests: "host-verified" });
    const command = core.search("npm test", { types: ["command"] })[0]!;
    core.rebuildModuleNarratives();
    core.rebuildRepositoryProfile();
    expect(core.getRepositoryProfile()?.sourceMemoryIds).toContain(command.id);

    // Simulate pre-provenance Evidence while retaining the historical memory.
    core.context.database.raw.prepare(`
      UPDATE evidence SET metadata_json=json_remove(metadata_json, '$.verificationSource')
      WHERE session_id=? AND kind='test_result'
    `).run(submitted.sessionId);
    const stored = core.context.database.raw.prepare("SELECT * FROM memories WHERE id=?").get(command.id);

    const recalled = core.search("npm test", { types: ["command"] })[0]!;
    expect(recalled.title).toBe("Unverified command: npm test");
    expect(recalled.tags).not.toContain("verified-command");
    expect(recalled.tags).not.toContain("host-verified");
    expect(recalled.confidence).toBe(0.5);
    expect(recalled.warning).toContain("verification source is unknown");
    expect(core.inspect(command.id)).toMatchObject({ title: recalled.title, warning: recalled.warning });
    expect(core.context.database.raw.prepare("SELECT * FROM memories WHERE id=?").get(command.id)).toEqual(stored);
    expect(core.getRepositoryProfile()?.current).toBe(false);
    expect(core.listModuleNarratives().every((module) => !module.current)).toBe(true);
    core.rebuildModuleNarratives();
    core.rebuildRepositoryProfile();
    expect(core.getRepositoryProfile()?.sourceMemoryIds).not.toContain(command.id);
    expect(core.listModuleNarratives().flatMap((module) => module.sourceMemoryIds)).not.toContain(command.id);
  });
});
