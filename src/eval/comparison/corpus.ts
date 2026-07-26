import { DatabaseSync } from "node:sqlite";
import { buildMatchExpression, searchTokens } from "../../search/lexical.js";
import type { Fixture, FixtureSession } from "./fixture.js";

export type ChunkKind = "task" | "summary" | "decision" | "test" | "command" | "note" | "diff";

export interface CorpusChunk {
  id: string;
  kind: ChunkKind;
  text: string;
  sessionIndex: number;
  sessionId: string;
}

/**
 * The raw session record every non-RepoMind arm retrieves from. Building it in
 * the same loop that writes to RepoMind is what makes information parity
 * structural: a fact RepoMind's extractor drops is still visible here, and
 * counts as a RepoMind loss rather than disappearing from the comparison.
 */
export class RawCorpus {
  readonly chunks: CorpusChunk[] = [];

  add(sessionIndex: number, session: FixtureSession, kind: ChunkKind, text: string, ordinal: number): void {
    this.chunks.push({
      id: `${session.id}:${kind}:${ordinal}`,
      kind,
      text,
      sessionIndex,
      sessionId: session.id,
    });
  }

  text(): string {
    return this.chunks.map((chunk) => chunk.text).join("\n");
  }

  get sessionCount(): number {
    return new Set(this.chunks.map((chunk) => chunk.sessionId)).size;
  }

  /**
   * Indexes the raw corpus in a throwaway in-memory FTS5 table using the same
   * tokenization production search uses, so a lexical baseline cannot lose for
   * a reason RepoMind is structurally protected from.
   */
  buildIndex(): CorpusIndex {
    return new CorpusIndex(this.chunks);
  }
}

export class CorpusIndex {
  private readonly db: DatabaseSync;
  private readonly byId = new Map<string, CorpusChunk>();

  constructor(chunks: CorpusChunk[]) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("CREATE VIRTUAL TABLE chunks USING fts5(chunk_id UNINDEXED, body, tokens)");
    const insert = this.db.prepare("INSERT INTO chunks(chunk_id, body, tokens) VALUES (?, ?, ?)");
    for (const chunk of chunks) {
      this.byId.set(chunk.id, chunk);
      insert.run(chunk.id, chunk.text, searchTokens(chunk.text, "", [], []));
    }
  }

  /** BM25-ranked chunks, best first. An empty query yields nothing. */
  search(query: string, limit = 200): Array<{ chunk: CorpusChunk; score: number }> {
    const match = buildMatchExpression(query);
    if (!match) return [];
    const rows = this.db.prepare(
      "SELECT chunk_id, bm25(chunks) AS rank FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?",
    ).all(match, limit) as Array<{ chunk_id: string; rank: number }>;
    return rows.map((row) => ({ chunk: this.byId.get(String(row.chunk_id))!, score: Number(row.rank) }));
  }

  close(): void {
    this.db.close();
  }
}

/** Chunks a file into overlapping line windows for the repo-file retriever. */
export function chunkFile(path: string, content: string, size = 40, overlap = 8): Array<{ id: string; text: string }> {
  const lines = content.split(/\r?\n/u);
  if (lines.length <= size) return [{ id: `${path}#0`, text: `${path}\n${content}` }];
  const chunks: Array<{ id: string; text: string }> = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + size);
    if (!slice.length) break;
    chunks.push({ id: `${path}#${start}`, text: `${path}:${start + 1}\n${slice.join("\n")}` });
    if (start + size >= lines.length) break;
  }
  return chunks;
}

/**
 * Renders one history session the way a "dump the whole transcript" baseline
 * would: everything the session produced, unfiltered and unflagged.
 */
export function renderSession(session: FixtureSession, diff: string | null): string {
  const parts = [`### Session ${session.id} (${session.status})`, `Task: ${session.task}`, `Summary: ${session.summary}`];
  for (const decision of session.decisions ?? []) parts.push(`Decision: ${decision}`);
  for (const test of session.tests ?? []) parts.push(`Test: ${test.command} (exit ${test.exitCode}) ${test.summary}`);
  for (const command of session.commands ?? []) parts.push(`Command: ${command.command} (exit ${command.exitCode}) ${command.summary}`);
  for (const note of session.notes ?? []) parts.push(`Note: ${note}`);
  if (diff) parts.push(diff);
  return parts.join("\n");
}

/** Truncates a diff body to a bounded size with an explicit elision marker. */
export function renderDiff(files: string[], patch: string, limit = 1200): string {
  const header = `Diff: ${files.join(", ")}`;
  if (patch.length <= limit) return `${header}\n${patch}`;
  const elided = patch.length - limit;
  return `${header}\n${patch.slice(0, limit)}\n[... ${elided} chars elided ...]`;
}

export function buildCorpus(fixture: Fixture, sessionDiffs: Map<string, string | null>): RawCorpus {
  const corpus = new RawCorpus();
  fixture.history.forEach((session, index) => {
    corpus.add(index, session, "task", `Task: ${session.task}`, 0);
    corpus.add(index, session, "summary", `Summary (${session.status}): ${session.summary}`, 0);
    (session.decisions ?? []).forEach((decision, ordinal) => corpus.add(index, session, "decision", `Decision: ${decision}`, ordinal));
    (session.tests ?? []).forEach((test, ordinal) =>
      corpus.add(index, session, "test", `Test: ${test.command} (exit ${test.exitCode}) ${test.summary}`, ordinal));
    (session.commands ?? []).forEach((command, ordinal) =>
      corpus.add(index, session, "command", `Command: ${command.command} (exit ${command.exitCode}) ${command.summary}`, ordinal));
    (session.notes ?? []).forEach((note, ordinal) => corpus.add(index, session, "note", `Note: ${note}`, ordinal));
    const diff = sessionDiffs.get(session.id);
    if (diff) corpus.add(index, session, "diff", diff, 0);
  });
  return corpus;
}
