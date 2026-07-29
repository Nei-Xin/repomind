import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RepositoryMemoryCore } from "../core.js";
import { RepoMindError } from "../errors.js";
import { VERSION } from "../version.js";

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
  const server = new McpServer({ name: "repomind", version: VERSION });
  const cores = new Map<string, RepositoryMemoryCore>();
  const sessionRepositories = new Map<string, string>();
  const memoryRepositories = new Map<string, string>();
  const narrativeRepositories = new Map<string, string>();
  const candidateRepositories = new Map<string, string>();
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
      include_repository_profile: z.boolean().optional(),
    },
    async (input) => {
      try {
        const value = await coreFor(input.repo_path).startSessionHybrid({
          task: input.task,
          ...(input.client_name ? { clientName: input.client_name } : {}),
          ...(input.client_session_id ? { clientSessionId: input.client_session_id } : {}),
          ...(input.max_memories ? { maxMemories: input.max_memories } : {}),
          ...(input.include_repository_profile !== undefined ? { includeRepositoryProfile: input.include_repository_profile } : {}),
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
    "Search repository-scoped memories using hybrid FTS/vector retrieval when configured, with deterministic FTS fallback and file-staleness warnings.",
    {
      query: z.string().min(1),
      repo_path: z.string().min(1),
      types: z.array(z.enum(["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"])).optional(),
      statuses: z.array(z.enum(["active", "uncertain"])).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (input) => {
      try {
        const value = await coreFor(input.repo_path).searchHybrid(input.query, {
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.types ? { types: input.types } : {}),
          ...(input.statuses ? { statuses: input.statuses } : {}),
        });
        for (const memory of value.memories) memoryRepositories.set(memory.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_review",
    "List uncertain memories that require human validation, correction, or invalidation.",
    {
      repo_path: z.string().min(1),
      kind: z.enum(["all", "stale", "conflict", "other"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).review({
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });
        for (const memory of value.items) memoryRepositories.set(memory.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_memory_review_apply",
    "Atomically apply user-approved validate or invalidate decisions to pending review memories.",
    {
      repo_path: z.string().min(1),
      actions: z.array(z.object({
        memory_id: z.string().min(1),
        action: z.enum(["validate", "invalidate"]),
        reason: z.string().min(1),
      })).min(1).max(100),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).applyReview(input.actions.map((item) => ({
          memoryId: item.memory_id,
          action: item.action,
          reason: item.reason,
        })));
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_module_rebuild",
    "Incrementally rebuild bounded L2 module narratives from active evidence-backed L1 memories.",
    {
      repo_path: z.string().min(1),
      modules: z.array(z.string().min(1)).min(1).optional(),
      max_chars: z.number().int().min(500).max(20_000).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).rebuildModuleNarratives({
          ...(input.modules ? { modules: input.modules } : {}),
          ...(input.max_chars ? { maxChars: input.max_chars } : {}),
        });
        for (const narrative of value.narratives) narrativeRepositories.set(narrative.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_module_list",
    "List L2 module narratives and report whether each still matches its active L1 sources.",
    { repo_path: z.string().min(1) },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).listModuleNarratives();
        for (const narrative of value) narrativeRepositories.set(narrative.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_module_inspect",
    "Inspect one L2 narrative and trace every conclusion to L1 memories and Evidence ids.",
    { narrative_id: z.string().min(1), repo_path: z.string().optional() },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? narrativeRepositories.get(input.narrative_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the narrative was not returned by this server process");
        const value = coreFor(repoPath).inspectModuleNarrative(input.narrative_id);
        narrativeRepositories.set(input.narrative_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_profile_rebuild",
    "Rebuild the bounded L3 Repository Profile from stable evidence-backed L1 and L2 sources.",
    {
      repo_path: z.string().min(1),
      max_chars: z.number().int().min(1000).max(30_000).optional(),
      min_confidence: z.number().min(0.5).max(1).optional(),
    },
    async (input) => {
      try {
        return result(coreFor(input.repo_path).rebuildRepositoryProfile({
          ...(input.max_chars ? { maxChars: input.max_chars } : {}),
          ...(input.min_confidence !== undefined ? { minConfidence: input.min_confidence } : {}),
        }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_profile_get",
    "Get the current L3 Repository Profile summary and freshness state.",
    { repo_path: z.string().min(1) },
    async (input) => {
      try {
        return result(coreFor(input.repo_path).getRepositoryProfile());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_profile_inspect",
    "Inspect the L3 profile, its L1/L2 provenance, and every retained profile version.",
    { repo_path: z.string().min(1) },
    async (input) => {
      try {
        return result(coreFor(input.repo_path).inspectRepositoryProfile());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_skill_candidate_rebuild",
    "Build L4 Skill Candidates only from repeated successful repository workflows. Candidates always require human review.",
    {
      repo_path: z.string().min(1),
      min_sessions: z.number().int().min(3).max(20).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).rebuildSkillCandidates({
          ...(input.min_sessions ? { minSessions: input.min_sessions } : {}),
        });
        for (const candidate of value.candidates) candidateRepositories.set(candidate.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_skill_candidate_list",
    "List repository-scoped L4 Skill Candidates and their human-review status.",
    {
      repo_path: z.string().min(1),
      status: z.enum(["pending", "approved", "rejected"]).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).listSkillCandidates(input.status);
        for (const candidate of value) candidateRepositories.set(candidate.id, input.repo_path);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_skill_candidate_inspect",
    "Inspect an L4 Skill Candidate, its successful source sessions, Evidence ids, and audit history.",
    {
      candidate_id: z.string().min(1),
      repo_path: z.string().optional(),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? candidateRepositories.get(input.candidate_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the candidate was not returned by this server process");
        const value = coreFor(repoPath).inspectSkillCandidate(input.candidate_id);
        candidateRepositories.set(input.candidate_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_skill_candidate_review",
    "Approve or reject a pending L4 Skill Candidate after explicit human review.",
    {
      candidate_id: z.string().min(1),
      repo_path: z.string().optional(),
      action: z.enum(["approve", "reject"]),
      reason: z.string().min(1),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? candidateRepositories.get(input.candidate_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the candidate was not returned by this server process");
        const value = coreFor(repoPath).reviewSkillCandidate({
          candidateId: input.candidate_id,
          action: input.action,
          reason: input.reason,
        });
        candidateRepositories.set(input.candidate_id, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_skill_candidate_export",
    "Export an approved L4 Skill Candidate as a new reviewable SKILL.md file without installing or executing it.",
    {
      candidate_id: z.string().min(1),
      repo_path: z.string().optional(),
      output_path: z.string().min(1),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? candidateRepositories.get(input.candidate_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required when the candidate was not returned by this server process");
        return result(coreFor(repoPath).exportSkillCandidate(input.candidate_id, input.output_path));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_session_commit",
    "Commit a task result, capture final Git evidence, and store deterministic local L1 memories. Remote LLM extraction is a separate explicit tool.",
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
    "repo_memory_extract",
    "Explicitly send one completed Session's redacted Evidence to the configured remote LLM, validate the complete response, and atomically store evidence-backed L1 memories.",
    {
      session_id: z.string().min(1),
      repo_path: z.string().optional(),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? sessionRepositories.get(input.session_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required after an MCP server restart");
        const value = await coreFor(repoPath).extractSession({ sessionId: input.session_id });
        for (const memoryId of value.memories.ids) memoryRepositories.set(memoryId, repoPath);
        return result(value);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "repo_session_abandon",
    "Abandon an open session after an interrupted or cancelled task.",
    {
      session_id: z.string().min(1),
      repo_path: z.string().optional(),
    },
    async (input) => {
      try {
        const repoPath = input.repo_path ?? sessionRepositories.get(input.session_id);
        if (!repoPath) throw new RepoMindError("INVALID_INPUT", "repo_path is required after an MCP server restart");
        coreFor(repoPath).abandonSession(input.session_id);
        sessionRepositories.delete(input.session_id);
        return result({ sessionId: input.session_id, status: "abandoned" });
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
    "repo_memory_record",
    "Record an explicit repository fact as a manual evidence-backed memory.",
    {
      repo_path: z.string().min(1),
      type: z.enum(["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"]),
      title: z.string().min(1),
      content: z.string().min(1),
      confidence: z.number().min(0).max(1).optional(),
      scope_type: z.enum(["repository", "module", "path"]).optional(),
      scope_value: z.string().optional(),
      tags: z.array(z.string()).optional(),
      related_files: z.array(z.string()).optional(),
    },
    async (input) => {
      try {
        const value = coreFor(input.repo_path).record({
          type: input.type,
          title: input.title,
          content: input.content,
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.scope_type ? { scopeType: input.scope_type } : {}),
          ...(input.scope_value ? { scopeValue: input.scope_value } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.related_files ? { relatedFiles: input.related_files } : {}),
        });
        memoryRepositories.set(value.id, input.repo_path);
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
