import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
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

  it("publishes four tools and starts a session through the protocol", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "repomind-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "repo_memory_inspect",
        "repo_memory_search",
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
});
