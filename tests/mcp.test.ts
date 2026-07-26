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
        "repo_memory_inspect",
        "repo_memory_invalidate",
        "repo_memory_search",
        "repo_memory_validate",
        "repo_session_commit",
        "repo_session_start",
      ]);
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
});
