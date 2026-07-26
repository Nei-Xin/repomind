import { DatabaseSync } from "node:sqlite";
import { buildMatchExpression, searchTokens } from "../../search/lexical.js";
import { chunkFile } from "./corpus.js";
import { packToBudget } from "./pack.js";
import type { Arm, ArmContext, ArmKey, ContextBundle, ContextRecord } from "./types.js";

const SEARCH_CAP = 20;

function memoryRecord(
  memory: { id: string; title: string; content: string; status: string; warning?: string },
  rank: number,
  hasEvidence: boolean,
  options: { includeWarning?: boolean } = {},
): ContextRecord {
  const warning = options.includeWarning === false ? undefined : memory.warning;
  const text = [`[${memory.status}] ${memory.title}`, memory.content, warning ? `Warning: ${warning}` : ""]
    .filter(Boolean)
    .join("\n");
  return {
    kind: "memory",
    text,
    memoryId: memory.id,
    memoryStatus: memory.status,
    rank,
    hasEvidence,
    ...(warning ? { warned: true } : {}),
  };
}

function evidenceCount(context: ArmContext, memoryId: string): number {
  const row = context.core.context.database.raw
    .prepare("SELECT count(*) AS count FROM memory_evidence WHERE memory_id=?")
    .get(memoryId) as { count: number };
  return Number(row.count);
}

/**
 * Reference arm: the fixture's own gold facts, minimally rendered. Normalizes
 * every other arm as a percentage of what is achievable and catches fixtures
 * whose gold facts are unreachable. Never enters the win/loss ledger.
 */
const oracleCeiling: Arm = {
  key: "oracle-ceiling",
  description: "The fixture's gold facts rendered minimally; an upper bound, not a competitor.",
  available: true,
  status: "run",
  reference: true,
  assemble(context) {
    const records: ContextRecord[] = context.fixture.goldFacts.map((fact) => ({
      kind: "gold",
      text: [...(fact.matcher.allOf ?? []), ...(fact.matcher.anyOf ?? []).map((group) => group[0]!)].join(" "),
    }));
    return packToBudget("oracle-ceiling", [...context.repoBase, ...records], context.budget);
  },
};

/**
 * No cross-session memory, but not helpless: an agent without memory still
 * greps the repository. Retrieval runs over repository file chunks with the
 * same tokenizer and ranker RepoMind uses, so this baseline loses only where
 * memory genuinely adds something.
 */
const noMemory: Arm = {
  key: "no-memory",
  description: "Repository base plus BM25 retrieval over repository file chunks. No memory database.",
  available: true,
  status: "run",
  assemble(context) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE chunks USING fts5(chunk_id UNINDEXED, body, tokens)");
      const insert = db.prepare("INSERT INTO chunks(chunk_id, body, tokens) VALUES (?, ?, ?)");
      const texts = new Map<string, string>();
      for (const [path, content] of context.repoFiles) {
        for (const chunk of chunkFile(path, content)) {
          texts.set(chunk.id, chunk.text);
          insert.run(chunk.id, chunk.text, searchTokens(chunk.text, "", [], []));
        }
      }
      const match = buildMatchExpression(context.fixture.query);
      const rows = match
        ? db.prepare("SELECT chunk_id FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT 50").all(match) as Array<{ chunk_id: string }>
        : [];
      const records: ContextRecord[] = rows.map((row) => ({ kind: "repo_chunk", text: texts.get(String(row.chunk_id)) ?? "" }));
      return packToBudget("no-memory", [...context.repoBase, ...records], context.budget);
    } finally {
      db.close();
    }
  },
};

/**
 * Inject everything, newest first. This baseline is not ignorant — it contains
 * every fact the corpus holds. Its cost is tokens and noise, and it carries no
 * governance by design, so superseded and retracted content appears unflagged.
 */
const fullHistory: Arm = {
  key: "full-history",
  description: "Repository base plus every session rendered whole, newest first, unfiltered and unflagged.",
  available: true,
  status: "run",
  assemble(context) {
    const bySession = new Map<string, string[]>();
    for (const chunk of context.corpus.chunks) {
      const list = bySession.get(chunk.sessionId) ?? [];
      list.push(chunk.text);
      bySession.set(chunk.sessionId, list);
    }
    const ordered = [...bySession.entries()].reverse();
    const records: ContextRecord[] = ordered.map(([sessionId, parts]) => ({
      kind: "session",
      text: `### Session ${sessionId}\n${parts.join("\n")}`,
    }));
    return packToBudget("full-history", [...context.repoBase, ...records], context.budget);
  },
};

/**
 * Lexical stand-in for flat RAG: the same tokenizer, match builder, and BM25
 * ranker RepoMind uses, applied to the raw corpus with no governance at all.
 * The recency weight is swept rather than guessed, so the arm is not
 * handicapped by one arbitrary constant.
 */
function flatLexicalRag(alpha: number): Arm {
  return {
    key: "flat-lexical-rag",
    description: "BM25 over raw session text with a recency weight and no governance.",
    available: true,
    status: "run",
    assemble(context) {
      const index = context.corpus.buildIndex();
      try {
        const hits = index.search(context.fixture.query);
        const sessions = Math.max(1, context.corpus.sessionCount - 1);
        const ranked = hits
          .map((hit) => ({
            chunk: hit.chunk,
            // bm25 returns more-negative for better matches; recency scales it.
            score: hit.score * (1 + (alpha * hit.chunk.sessionIndex) / sessions),
          }))
          .sort((a, b) => a.score - b.score);
        const records: ContextRecord[] = ranked.map((hit, index_) => ({
          kind: "session",
          text: hit.chunk.text,
          rank: index_ + 1,
        }));
        return packToBudget("flat-lexical-rag", [...context.repoBase, ...records], context.budget, { alpha });
      } finally {
        index.close();
      }
    },
  };
}

/**
 * No query, no ranking, no relevance signal — just the most recently updated
 * memories. Exists to answer whether the retrieval machinery earns its keep.
 */
const recencyK: Arm = {
  key: "recency-k",
  description: "The most recently updated live memories, with no query and no ranking.",
  available: true,
  status: "run",
  assemble(context) {
    const rows = context.core.context.database.raw.prepare(`
      SELECT id, title, content, status FROM memories
      WHERE repository_id=? AND status IN ('active','uncertain')
      ORDER BY updated_at DESC, id
    `).all(context.core.context.marker.projectId) as Array<{ id: string; title: string; content: string; status: string }>;
    const records = rows.map((row, index) => memoryRecord(row, index + 1, evidenceCount(context, row.id) > 0));
    return packToBudget("recency-k", [...context.repoBase, ...records], context.budget);
  },
};

/**
 * RepoMind's curation without its governance: same FTS ranking, but every
 * status is eligible, staleness is not refreshed, and warnings are stripped.
 * Isolates how much of the benefit comes from governance rather than curation.
 * Implemented as arm-local SQL so production never gets a bypass flag.
 */
const repomindNogov: Arm = {
  key: "repomind-nogov",
  description: "RepoMind curation with governance disabled: all statuses, no staleness refresh, no warnings.",
  available: true,
  status: "run",
  assemble(context) {
    const db = context.core.context.database.raw;
    const match = buildMatchExpression(context.fixture.query);
    const projectId = context.core.context.marker.projectId;
    let rows: Array<{ id: string; title: string; content: string; status: string }> = [];
    if (match) {
      rows = db.prepare(`
        SELECT m.id, m.title, m.content, m.status, bm25(memory_fts) AS rank
        FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
        WHERE memory_fts MATCH ? AND m.repository_id = ?
        ORDER BY rank LIMIT ?
      `).all(match, projectId, SEARCH_CAP) as typeof rows;
    }
    if (rows.length < SEARCH_CAP) {
      const existing = new Set(rows.map((row) => row.id));
      const fallback = db.prepare(`
        SELECT m.id, m.title, m.content, m.status FROM memories m
        WHERE m.repository_id = ? AND (m.title LIKE ? OR m.content LIKE ?)
        ORDER BY m.updated_at DESC LIMIT ?
      `).all(projectId, `%${context.fixture.query}%`, `%${context.fixture.query}%`, SEARCH_CAP) as typeof rows;
      rows.push(...fallback.filter((row) => !existing.has(row.id)).slice(0, SEARCH_CAP - rows.length));
    }
    const records = rows.map((row, index) =>
      memoryRecord(row, index + 1, evidenceCount(context, row.id) > 0, { includeWarning: false }));
    return packToBudget("repomind-nogov", [...context.repoBase, ...records], context.budget, { capBound: rows.length >= SEARCH_CAP });
  },
};

/** RepoMind exactly as an agent gets it, with no benchmark-only advantages. */
const repomind: Arm = {
  key: "repomind",
  description: "core.search as shipped, warnings included.",
  available: true,
  status: "run",
  assemble(context) {
    const memories = context.core.search(context.fixture.query, { limit: SEARCH_CAP });
    const records = memories.map((memory, index) =>
      memoryRecord(memory, index + 1, evidenceCount(context, memory.id) > 0));
    return packToBudget("repomind", [...context.repoBase, ...records], context.budget, { capBound: memories.length >= SEARCH_CAP });
  },
};

/**
 * Declared but unavailable: the product has no embeddings, so shipping a
 * vector arm now would mean inventing its results. Its contract is fixed here
 * so the comparisons it would decide are reported as unresolved rather than
 * quietly credited to RepoMind.
 */
const flatVectorRag: Arm = {
  key: "flat-vector-rag",
  description: "Cosine retrieval over an offline embedding fixture, indexed over the raw corpus.",
  available: false,
  status: "unavailable",
  reason: "No embedding support in the product; committing precomputed vectors would fabricate a comparison.",
  assemble() {
    throw new Error("flat-vector-rag is unavailable");
  },
};

const layeredHybrid: Arm = {
  key: "repomind-layered-hybrid",
  description: "Hybrid lexical and vector retrieval over layered memories.",
  available: false,
  status: "not-implemented",
  reason: "capabilities.vector === false; L2/L3 layers are not implemented.",
  assemble() {
    throw new Error("repomind-layered-hybrid is not implemented");
  },
};

export const ALPHA_GRID = [0, 0.15, 0.35, 0.6, 1.0];

export function buildArms(alpha: number): Arm[] {
  return [oracleCeiling, noMemory, fullHistory, flatLexicalRag(alpha), recencyK, repomindNogov, repomind, flatVectorRag, layeredHybrid];
}

export const SCORING_ARMS: ArmKey[] = [
  "no-memory", "full-history", "flat-lexical-rag", "recency-k", "repomind-nogov", "repomind",
];

export { flatLexicalRag };
export type { ContextBundle };
