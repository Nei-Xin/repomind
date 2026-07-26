import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RepositoryMemoryCore } from "../core.js";
import { RepoMindError } from "../errors.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const payload = error instanceof RepoMindError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "repomind", version: "0.3.0" });
  const cores = new Map<string, RepositoryMemoryCore>();
  const sessionRepositories = new Map<string, string>();
  const memoryRepositories = new Map<string, string>();
  const coreFor = (repoPath: string): RepositoryMemoryCore => {
    let core = cores.get(repoPath);
    if (!core) {
      core = new RepositoryMemoryCore(repoPath);
      cores.set(repoPath, core);
    }
    return core;
  };

  server.tool(
    "repo_session_start",
    "Start a repository task, capture its Git baseline, and recall relevant evidence-backed memories.",
    {
      task: z.string().min(1),
      repo_path: z.string().min(1),
      client_name: z.string().optional(),
      client_session_id: z.string().optional(),
      max_memories: z.number().int().min(1).max(20).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).startSession({
          task: input.task,
          ...(input.client_name ? { clientName: input.client_name } : {}),
          ...(input.client_session_id ? { clientSessionId: input.client_session_id } : {}),
          ...(input.max_memories ? { maxMemories: input.max_memories } : {}),
        });
        sessionRepositories.set(value.sessionId, input.repo_path);
        for (const memory of value.memories) memoryRepositories.set(memory.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_search",
    "Search repository-scoped memories using FTS and deterministic filters, with file-staleness warnings.",
    {
      query: z.string().min(1),
      repo_path: z.string().min(1),
      types: z.array(z.enum(["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"])).optional(),
      statuses: z.array(z.enum(["active", "uncertain"])).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (input) => {
      try {
        const memories = coreFor(input.repo_path).search(input.query, {
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.types ? { types: input.types } : {}),
          ...(input.statuses ? { statuses: input.statuses } : {}),
        });
        for (const memory of memories) memoryRepositories.set(memory.id, input.repo_path);
        return result({ strategy: "fts5-with-substring-fallback", memories });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_session_commit",
    "Commit a task result, capture final Git evidence, and store deterministic L1 memories.",
    {
      session_id: z.string().min(1),
      repo_path: z.string().optional(),
      idempotency_key: z.string().min(1),
      status: z.enum(["success", "partial", "failed"]),
      summary: z.string(),
      decisions: z.array(z.string()).optional(),
      tests: z.array(z.object({ command: z.string(), exit_code: z.number().int(), summary: z.string() })).optional(),
      commands: z.array(z.object({ command: z.string(), exit_code: z.number().int(), summary: z.string() })).optional(),
      remaining_work: z.array(z.string()).optional(),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? sessionRepositories.get(input.session_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required after an MCP server restart");
        const value = coreFor(repoPath).commitSession({
          sessionId: input.session_id,
          idempotencyKey: input.idempotency_key,
          status: input.status,
          summary: input.summary,
          ...(input.decisions ? { decisions: input.decisions } : {}),
          ...(input.tests ? { tests: input.tests.map((item) => ({ command: item.command, exitCode: item.exit_code, summary: item.summary })) } : {}),
          ...(input.commands ? { commands: input.commands.map((item) => ({ command: item.command, exitCode: item.exit_code, summary: item.summary })) } : {}),
          ...(input.remaining_work ? { remainingWork: input.remaining_work } : {}),
        });
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_inspect",
    "Inspect one memory, its evidence, related files, and audit history.",
    { memory_id: z.string().min(1), repo_path: z.string().optional() },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? memoryRepositories.get(input.memory_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the memory was not returned by this server process");
        const value = coreFor(repoPath).inspect(input.memory_id);
        memoryRepositories.set(input.memory_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_validate",
    "Accept the current related-file hashes and return an active or uncertain memory to active status.",
    {
      memory_id: z.string().min(1),
      repo_path: z.string().optional(),
      reason: z.string().min(1),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? memoryRepositories.get(input.memory_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the memory was not returned by this server process");
        const value = coreFor(repoPath).validateMemory({ memoryId: input.memory_id, reason: input.reason });
        memoryRepositories.set(input.memory_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_correct",
    "Create an evidence-backed replacement and mark the previous memory as superseded.",
    {
      memory_id: z.string().min(1),
      repo_path: z.string().optional(),
      reason: z.string().min(1),
      title: z.string().min(1),
      content: z.string().min(1),
      type: z.enum(["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
      related_files: z.array(z.string()).optional(),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? memoryRepositories.get(input.memory_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the memory was not returned by this server process");
        const value = coreFor(repoPath).correctMemory({
          memoryId: input.memory_id,
          reason: input.reason,
          title: input.title,
          content: input.content,
          ...(input.type ? { type: input.type } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.related_files ? { relatedFiles: input.related_files } : {}),
        });
        memoryRepositories.set(input.memory_id, repoPath);
        memoryRepositories.set(value.replacementMemoryId, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_invalidate",
    "Mark a disproven memory invalid while preserving its evidence and audit history.",
    {
      memory_id: z.string().min(1),
      repo_path: z.string().optional(),
      reason: z.string().min(1),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? memoryRepositories.get(input.memory_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the memory was not returned by this server process");
        const value = coreFor(repoPath).invalidateMemory({ memoryId: input.memory_id, reason: input.reason });
        memoryRepositories.set(input.memory_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_forget",
    "Permanently delete a memory and, by default, any evidence used only by that memory. Requires confirm=true.",
    {
      memory_id: z.string().min(1),
      repo_path: z.string().optional(),
      reason: z.string().min(1),
      scope: z.enum(["memory", "memory-and-evidence"]).optional(),
      confirm: z.boolean(),
    },
    async (input) => {
      try {
        if (input.confirm !== true) {
          throw new RepoMindError("INVALID_INPUT", "Forgetting is permanent; pass confirm=true after the user approved the deletion");
        }
        const repoPath = input.repo_path ?? memoryRepositories.get(input.memory_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the memory was not returned by this server process");
        const value = coreFor(repoPath).forgetMemory({
          memoryId: input.memory_id,
          reason: input.reason,
          ...(input.scope ? { scope: input.scope } : {}),
        });
        memoryRepositories.delete(input.memory_id);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  const originalClose = server.close.bind(server);
  server.close = async () => {
    for (const core of cores.values()) core.close();
    cores.clear();
    await originalClose();
  };
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  process.once("SIGINT", () => void server.close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void server.close().finally(() => process.exit(0)));
  await server.connect(transport);
}
