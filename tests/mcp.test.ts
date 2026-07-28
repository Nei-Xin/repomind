import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("MCP server", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("publishes session and memory governance tools and starts a session through the protocol", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "repo_memory_correct",
        "repo_memory_forget",
        "repo_memory_inspect",
        "repo_memory_invalidate",
        "repo_memory_record",
        "repo_memory_review",
        "repo_memory_review_apply",
        "repo_memory_search",
        "repo_memory_validate",
        "repo_module_inspect",
        "repo_module_list",
        "repo_module_rebuild",
        "repo_profile_get",
        "repo_profile_inspect",
        "repo_profile_rebuild",
        "repo_session_abandon",
        "repo_session_commit",
        "repo_session_start",
      ]);
      const recordResponse = await client.callTool({
        name: "repo_memory_record",
        arguments: {
          repo_path: repository,
          type: "convention",
          title: "Recorded through MCP",
          content: "Facts can be recorded without an LLM through the MCP protocol.",
        },
      });
      expect(recordResponse.isError).not.toBe(true);
      const recordText = recordResponse.content[0]?.type === "text" ? recordResponse.content[0].text : "{}";
      expect(JSON.parse(recordText)).toMatchObject({ id: expect.stringMatching(/^mem_/), stored: true, conflicts: [] });
      const response = await client.callTool({
        name: "repo_session_start",
        arguments: { task: "Inspect SQLite conventions", repo_path: repository, client_name: "vitest" },
      });
      expect(response.isError).not.toBe(true);
      expect(response.content[0]).toMatchObject({ type: "text" });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
      expect(JSON.parse(text)).toMatchObject({ repositoryId: expect.any(String), sessionId: expect.stringMatching(/^ses_/) });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rebuilds, gets, and inspects a versioned L3 profile through MCP", async () => {
    const core = new RepositoryMemoryCore(repository);
    const source = core.record({
      type: "architecture", title: "Repository boundary", content: "RepoMind is local-first.", confidence: 0.95,
    });
    core.close();

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const rebuilt = await client.callTool({
        name: "repo_profile_rebuild",
        arguments: { repo_path: repository, max_chars: 1200, min_confidence: 0.8 },
      });
      const rebuiltText = rebuilt.content[0]?.type === "text" ? rebuilt.content[0].text : "{}";
      expect(JSON.parse(rebuiltText)).toMatchObject({ created: true, profile: { version: 1, current: true } });

      const profile = await client.callTool({ name: "repo_profile_get", arguments: { repo_path: repository } });
      const profileText = profile.content[0]?.type === "text" ? profile.content[0].text : "{}";
      expect(JSON.parse(profileText)).toMatchObject({ version: 1, current: true });

      const inspected = await client.callTool({ name: "repo_profile_inspect", arguments: { repo_path: repository } });
      const inspectedText = inspected.content[0]?.type === "text" ? inspected.content[0].text : "{}";
      expect(JSON.parse(inspectedText)).toMatchObject({
        memorySources: [{ memoryId: source.id, evidenceIds: [expect.stringMatching(/^evd_/)] }],
        versions: [{ version: 1 }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rebuilds and inspects evidence-backed L2 module narratives through MCP", async () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({
      type: "architecture",
      title: "Storage boundary",
      content: "The storage module owns database transactions.",
      scopeType: "module",
      scopeValue: "src/storage",
    });
    core.close();

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const rebuilt = await client.callTool({
        name: "repo_module_rebuild",
        arguments: { repo_path: repository, modules: ["src/storage"], max_chars: 1000 },
      });
      const rebuiltText = rebuilt.content[0]?.type === "text" ? rebuilt.content[0].text : "{}";
      const narrative = (JSON.parse(rebuiltText) as { narratives: Array<{ id: string }> }).narratives[0]!;
      expect(narrative.id).toMatch(/^l2_/u);

      const inspected = await client.callTool({
        name: "repo_module_inspect",
        arguments: { narrative_id: narrative.id },
      });
      const inspectedText = inspected.content[0]?.type === "text" ? inspected.content[0].text : "{}";
      expect(JSON.parse(inspectedText)).toMatchObject({
        id: narrative.id,
        current: true,
        sources: [{ memoryId: expect.stringMatching(/^mem_/), evidenceIds: [expect.stringMatching(/^evd_/)] }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reviews a conflict and abandons an interrupted session through the protocol", async () => {
    const core = new RepositoryMemoryCore(repository);
    const first = core.record({ type: "decision", title: "Queue backend", content: "Use SQLite." });
    const second = core.record({ type: "decision", title: "Queue backend", content: "Use PostgreSQL." });
    core.close();

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const pending = await client.callTool({
        name: "repo_memory_review",
        arguments: { repo_path: repository, kind: "conflict" },
      });
      const pendingText = pending.content[0]?.type === "text" ? pending.content[0].text : "{}";
      expect(JSON.parse(pendingText)).toMatchObject({ pending: 2, returned: 2 });

      const applied = await client.callTool({
        name: "repo_memory_review_apply",
        arguments: {
          repo_path: repository,
          actions: [{ memory_id: second.id, action: "invalidate", reason: "SQLite is confirmed." }],
        },
      });
      const appliedText = applied.content[0]?.type === "text" ? applied.content[0].text : "{}";
      expect(JSON.parse(appliedText)).toMatchObject({ applied: 1, remaining: 0 });

      const started = await client.callTool({
        name: "repo_session_start",
        arguments: { task: "Interrupted task", repo_path: repository },
      });
      const startedText = started.content[0]?.type === "text" ? started.content[0].text : "{}";
      const sessionId = (JSON.parse(startedText) as { sessionId: string }).sessionId;
      const abandoned = await client.callTool({
        name: "repo_session_abandon",
        arguments: { session_id: sessionId },
      });
      const abandonedText = abandoned.content[0]?.type === "text" ? abandoned.content[0].text : "{}";
      expect(JSON.parse(abandonedText)).toEqual({ sessionId, status: "abandoned" });
      expect(first.id).toMatch(/^mem_/u);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns file staleness warnings through memory search", async () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Readme convention",
      content: "Keep the readme synchronized with behavior.",
      relatedFiles: ["README.txt"],
    });
    core.close();
    writeFileSync(join(repository, "README.txt"), "changed after memory creation\n", "utf8");

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "repo_memory_search",
        arguments: { query: "readme synchronized", repo_path: repository },
      });
      expect(response.isError).not.toBe(true);
      const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
      expect(JSON.parse(text)).toMatchObject({
        strategy: "fts5-with-substring-fallback",
        memories: [{
          id: recorded.id,
          status: "uncertain",
          warning: "This memory may be stale: README.txt changed.",
          staleReasons: [{ kind: "file_modified", filePath: "README.txt" }],
        }],
      });

      const validationResponse = await client.callTool({
        name: "repo_memory_validate",
        arguments: { memory_id: recorded.id, reason: "Reviewed the changed readme." },
      });
      expect(validationResponse.isError).not.toBe(true);
      const validationText = validationResponse.content[0]?.type === "text" ? validationResponse.content[0].text : "{}";
      expect(JSON.parse(validationText)).toMatchObject({ memoryId: recorded.id, status: "active" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("corrects and invalidates memories through the protocol", async () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "decision",
      title: "Old protocol decision",
      content: "Use the legacy protocol.",
    });
    core.close();

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "repo_memory_search",
        arguments: { query: "legacy protocol", repo_path: repository },
      });
      const correctionResponse = await client.callTool({
        name: "repo_memory_correct",
        arguments: {
          memory_id: recorded.id,
          reason: "The protocol was replaced.",
          title: "Current protocol decision",
          content: "Use the current protocol.",
        },
      });
      expect(correctionResponse.isError).not.toBe(true);
      const correctionText = correctionResponse.content[0]?.type === "text" ? correctionResponse.content[0].text : "{}";
      const correction = JSON.parse(correctionText) as { replacementMemoryId: string };
      expect(correction).toMatchObject({ memoryId: recorded.id, status: "superseded", replacementStored: true });

      const invalidationResponse = await client.callTool({
        name: "repo_memory_invalidate",
        arguments: { memory_id: correction.replacementMemoryId, reason: "The replacement was disproven." },
      });
      expect(invalidationResponse.isError).not.toBe(true);
      const invalidationText = invalidationResponse.content[0]?.type === "text" ? invalidationResponse.content[0].text : "{}";
      expect(JSON.parse(invalidationText)).toEqual({ memoryId: correction.replacementMemoryId, status: "invalid" });
      const inspectResponse = await client.callTool({
        name: "repo_memory_inspect",
        arguments: { memory_id: correction.replacementMemoryId },
      });
      expect(inspectResponse.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forgets a memory through the protocol only after explicit confirmation", async () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "convention",
      title: "Disposable convention",
      content: "This convention should be permanently forgettable.",
    });
    core.close();

    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const unconfirmed = await client.callTool({
        name: "repo_memory_forget",
        arguments: { memory_id: recorded.id, repo_path: repository, reason: "Cleanup", confirm: false },
      });
      expect(unconfirmed.isError).toBe(true);

      const confirmed = await client.callTool({
        name: "repo_memory_forget",
        arguments: { memory_id: recorded.id, repo_path: repository, reason: "User asked to remove it", confirm: true },
      });
      expect(confirmed.isError).not.toBe(true);
      const text = confirmed.content[0]?.type === "text" ? confirmed.content[0].text : "{}";
      expect(JSON.parse(text)).toEqual({ memoryId: recorded.id, scope: "memory-and-evidence", evidenceDeleted: 1 });

      const inspectResponse = await client.callTool({
        name: "repo_memory_inspect",
        arguments: { memory_id: recorded.id, repo_path: repository },
      });
      expect(inspectResponse.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
