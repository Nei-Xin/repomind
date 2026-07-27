import { createHash } from "node:crypto";
import type { MemoryType } from "../domain/types.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { serializeVector, validateEmbeddings } from "../embedding/provider.js";
import { RepoMindError } from "../errors.js";
import type { RepositoryContext } from "../repository.js";

interface MemoryDocument {
  id: string;
  title: string;
  content: string;
}

export interface VectorHit {
  id: string;
  distance: number;
  similarity: number;
}

export interface VectorSyncResult {
  model: string;
  dimensions: number;
  embedded: number;
  cached: number;
  total: number;
}

export function memoryEmbeddingText(memory: Pick<MemoryDocument, "title" | "content">): string {
  return `${memory.title}\n${memory.content}`;
}

function contentHash(memory: MemoryDocument): string {
  return createHash("sha256").update(memoryEmbeddingText(memory)).digest("hex");
}

export class VectorIndex {
  constructor(readonly context: RepositoryContext, readonly provider: EmbeddingProvider) {}

  async sync(force = false): Promise<VectorSyncResult> {
    if (!this.context.database.vector.available) {
      throw new RepoMindError("CAPABILITY_UNAVAILABLE", this.context.database.vector.error ?? "sqlite-vec is unavailable");
    }
    const db = this.context.database.raw;
    const memories = db.prepare("SELECT id, title, content FROM memories WHERE repository_id=? ORDER BY id")
      .all(this.context.marker.projectId) as unknown as MemoryDocument[];
    const cachedRows = db.prepare("SELECT memory_id, model, dimensions, content_hash FROM memory_embeddings WHERE repository_id=?")
      .all(this.context.marker.projectId) as unknown as Array<{ memory_id: string; model: string; dimensions: number; content_hash: string }>;
    const cached = new Map(cachedRows.map((row) => [row.memory_id, row]));
    const pending = memories.filter((memory) => {
      const row = cached.get(memory.id);
      return force || !row || row.model !== this.provider.model || row.dimensions !== this.provider.dimensions || row.content_hash !== contentHash(memory);
    });

    const vectors: number[][] = [];
    for (let offset = 0; offset < pending.length; offset += 64) {
      const batch = pending.slice(offset, offset + 64);
      const embedded = await this.provider.embed(batch.map(memoryEmbeddingText));
      validateEmbeddings(this.provider, embedded, batch.length);
      vectors.push(...embedded);
    }

    this.context.database.transaction(() => {
      if (force) db.prepare("DELETE FROM memory_embeddings WHERE repository_id=?").run(this.context.marker.projectId);
      const upsert = db.prepare(`
        INSERT INTO memory_embeddings(memory_id, repository_id, model, dimensions, content_hash, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dimensions=excluded.dimensions,
          content_hash=excluded.content_hash, embedding=excluded.embedding, updated_at=excluded.updated_at
      `);
      pending.forEach((memory, index) => {
        upsert.run(memory.id, this.context.marker.projectId, this.provider.model, this.provider.dimensions,
          contentHash(memory), serializeVector(vectors[index]!), Date.now());
      });
    });
    return { model: this.provider.model, dimensions: this.provider.dimensions, embedded: pending.length, cached: memories.length - pending.length, total: memories.length };
  }

  async search(
    query: string,
    options: { limit?: number; types?: MemoryType[]; statuses?: Array<"active" | "uncertain"> } = {},
  ): Promise<VectorHit[]> {
    await this.sync();
    const vectors = await this.provider.embed([query]);
    validateEmbeddings(this.provider, vectors, 1);
    const statuses = options.statuses ?? ["active", "uncertain"];
    const types = options.types ?? [];
    const conditions = ["m.repository_id=?", "me.model=?", "me.dimensions=?", `m.status IN (${statuses.map(() => "?").join(",")})`];
    const params: Array<string | number | Uint8Array> = [
      serializeVector(vectors[0]!), this.context.marker.projectId, this.provider.model, this.provider.dimensions, ...statuses,
    ];
    if (types.length) {
      conditions.push(`m.type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 20, 100)));
    const rows = this.context.database.raw.prepare(`
      SELECT m.id, vec_distance_cosine(me.embedding, ?) AS distance
      FROM memory_embeddings me JOIN memories m ON m.id=me.memory_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY distance, m.id LIMIT ?
    `).all(...params) as unknown as Array<{ id: string; distance: number }>;
    return rows.map((row) => ({ id: row.id, distance: Number(row.distance), similarity: 1 - Number(row.distance) }));
  }
}
