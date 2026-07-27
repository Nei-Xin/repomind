import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { DeterministicEmbeddingProvider } from "../src/embedding/deterministic.js";
import { OpenAICompatibleEmbeddingProvider } from "../src/embedding/openai-compatible.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import { initializeRepository } from "../src/repository.js";
import { VectorIndex } from "../src/search/vector-index.js";
import { createTestRepository } from "./helpers.js";

class CountingProvider implements EmbeddingProvider {
  readonly id = "counting";
  readonly remote = false;
  readonly calls: number[] = [];
  private readonly delegate: DeterministicEmbeddingProvider;

  constructor(readonly model = "counting-v1", readonly dimensions = 64) {
    this.delegate = new DeterministicEmbeddingProvider(dimensions, model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts.length);
    return this.delegate.embed(texts);
  }
}

describe("vector and hybrid retrieval", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("indexes once, uses sqlite-vec, and serves weighted hybrid results", async () => {
    const provider = new CountingProvider();
    const core = new RepositoryMemoryCore(repository, { embeddingProvider: provider });
    const sqlite = core.record({ type: "decision", title: "Storage engine", content: "SQLite is the local source of truth." });
    core.record({ type: "convention", title: "Logging", content: "Write structured JSON logs to stderr." });

    const first = await core.searchHybrid("SQLite local storage", { limit: 2 });
    expect(first.strategy).toBe("hybrid-fts5-vector");
    expect(first.memories[0]?.id).toBe(sqlite.id);
    expect(core.status()).toMatchObject({ capabilities: { vector: true, sqliteVec: { available: true } } });
    expect(core.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 2 });

    await core.searchHybrid("SQLite local storage", { limit: 2 });
    expect(provider.calls).toEqual([2, 1, 1]);
    const started = await core.startSessionHybrid({ task: "Work on SQLite local storage", maxMemories: 2 });
    expect(started.retrievalStrategy).toBe("hybrid-fts5-vector");
    expect(started.memories[0]?.id).toBe(sqlite.id);
    core.close();
  });

  it("falls back to FTS without partially writing an invalid provider response", async () => {
    const provider: EmbeddingProvider = {
      id: "broken",
      model: "broken-v1",
      dimensions: 64,
      remote: false,
      async embed() { return []; },
    };
    const core = new RepositoryMemoryCore(repository, { embeddingProvider: provider });
    const recorded = core.record({ type: "solution", title: "Migration rollback", content: "Run the down migration inside a transaction." });
    const result = await core.searchHybrid("Migration rollback");
    expect(result).toMatchObject({
      strategy: "fts5-with-substring-fallback",
      memories: [{ id: recorded.id }],
    });
    expect(result.fallbackReason).toContain("returned 0 vectors");
    expect(core.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 0 });
    core.close();
  });

  it("rebuilds for a model change and cascades vectors when a memory is forgotten", async () => {
    const firstProvider = new CountingProvider("model-a");
    const core = new RepositoryMemoryCore(repository, { embeddingProvider: firstProvider });
    const memory = core.record({ type: "requirement", title: "Supported runtime", content: "Node.js 22 or newer is required." });
    await core.reindexVectors();

    const secondProvider = new CountingProvider("model-b");
    const rebuilt = await new VectorIndex(core.context, secondProvider).sync();
    expect(rebuilt).toMatchObject({ embedded: 1, cached: 0, model: "model-b" });
    expect(core.context.database.raw.prepare("SELECT model FROM memory_embeddings WHERE memory_id=?").get(memory.id)).toEqual({ model: "model-b" });

    core.forgetMemory({ memoryId: memory.id, reason: "Test vector cascade." });
    expect(core.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 0 });
    core.close();
  });

  it("synchronizes corrected memories and excludes retired vector rows", async () => {
    const provider = new CountingProvider();
    const core = new RepositoryMemoryCore(repository, { embeddingProvider: provider });
    const original = core.record({ type: "decision", title: "Cache backend", content: "Use the local filesystem cache." });
    await core.reindexVectors();
    const corrected = core.correctMemory({
      memoryId: original.id,
      reason: "The deployment architecture changed.",
      title: "Cache backend",
      content: "Use Redis for the shared cache.",
    });

    const afterCorrection = await new VectorIndex(core.context, provider).search("Redis shared cache", { limit: 10 });
    expect(afterCorrection.map((hit) => hit.id)).toEqual([corrected.replacementMemoryId]);
    expect(core.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 2 });

    core.invalidateMemory({ memoryId: corrected.replacementMemoryId, reason: "Redis was removed." });
    await expect(new VectorIndex(core.context, provider).search("Redis shared cache", { limit: 10 })).resolves.toEqual([]);
    core.forgetMemory({ memoryId: corrected.replacementMemoryId, reason: "Remove the retired replacement." });
    expect(core.context.database.raw.prepare("SELECT memory_id FROM memory_embeddings ORDER BY memory_id").all())
      .toEqual([{ memory_id: original.id }]);
    core.close();
  });

  it("keeps vector results isolated between repository databases", async () => {
    const otherRepository = createTestRepository();
    initializeRepository(otherRepository).database.close();
    const first = new RepositoryMemoryCore(repository, { embeddingProvider: new CountingProvider() });
    const second = new RepositoryMemoryCore(otherRepository, { embeddingProvider: new CountingProvider() });
    try {
      const own = first.record({ type: "architecture", title: "API framework", content: "This repository uses Fastify." });
      second.record({ type: "architecture", title: "API framework", content: "This repository uses Hono." });
      const results = await first.searchHybrid("API framework Fastify", { limit: 10 });
      expect(results.memories.map((memory) => memory.id)).toEqual([own.id]);
      expect(first.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 1 });
      expect(second.context.database.raw.prepare("SELECT count(*) AS count FROM memory_embeddings").get()).toEqual({ count: 0 });
    } finally {
      first.close();
      second.close();
      rmSync(otherRepository, { recursive: true, force: true });
    }
  });

  it("parses ordered OpenAI-compatible embedding responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://embedding.example/v1/",
      apiKey: "test-key",
      model: "embed-test",
      dimensions: 3,
    });
    await expect(provider.embed(["first", "second"])).resolves.toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(fetch).toHaveBeenCalledWith("https://embedding.example/v1/embeddings", expect.objectContaining({ method: "POST" }));
  });
});
