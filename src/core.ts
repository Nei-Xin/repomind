import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CommitSessionInput,
  CommitSessionResult,
  EvidenceKind,
  MemoryResult,
  MemoryType,
  RecordMemoryInput,
  StartSessionInput,
  StartSessionResult,
} from "./domain/types.js";
import { RepoMindError } from "./errors.js";
import { captureDiff, inspectGit } from "./git/git-inspector.js";
import { openRepository, type RepositoryContext } from "./repository.js";

type SqlValue = string | number | null;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function titleFrom(text: string, fallback: string): string {
  const line = text.trim().split(/\r?\n/u)[0]?.trim() || fallback;
  return line.length > 96 ? `${line.slice(0, 93)}...` : line;
}

function searchTokens(title: string, content: string, tags: string[], files: string[]): string {
  const raw = [title, content, ...tags, ...files].join(" ");
  const splitIdentifiers = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[\\/_\-.]+/g, " ");
  return `${raw} ${splitIdentifiers}`.toLowerCase();
}

function extractFiles(status: string): string[] {
  return [...new Set(status.split(/\r?\n/u).filter(Boolean).map((line) => {
    const path = line.slice(3).trim();
    const renamed = path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
    return renamed?.replaceAll("\\", "/") ?? "";
  }).filter((path) => Boolean(path) && !path.startsWith(".repomind/")))];
}

export class RepositoryMemoryCore {
  readonly context: RepositoryContext;

  constructor(repositoryPath: string) {
    this.context = openRepository(repositoryPath);
  }

  close(): void {
    this.context.database.close();
  }

  startSession(input: StartSessionInput): StartSessionResult {
    if (!input.task.trim()) throw new RepoMindError("INVALID_INPUT", "task must not be empty");
    const snapshot = inspectGit(this.context.root);
    const sessionId = `ses_${randomUUID()}`;
    const now = Date.now();
    const db = this.context.database;
    db.transaction(() => {
      db.raw.prepare(`
        INSERT INTO sessions(id, repository_id, checkout_id, client_name, client_session_id, task, status,
          baseline_branch, baseline_head, baseline_dirty, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).run(
        sessionId, this.context.marker.projectId, this.context.checkoutId,
        input.clientName ?? null, input.clientSessionId ?? null, input.task.trim(),
        snapshot.branch, snapshot.head, snapshot.dirty ? 1 : 0, now,
      );
      this.insertEvidence(sessionId, "user_requirement", input.task.trim(), {}, null);
      this.insertEvidence(sessionId, "git_snapshot", JSON.stringify(snapshot), { phase: "baseline" }, snapshot.head);
    });
    return {
      sessionId,
      repositoryId: this.context.marker.projectId,
      baseline: snapshot,
      memories: this.search(input.task, { limit: input.maxMemories ?? 5 }),
    };
  }

  commitSession(input: CommitSessionInput): CommitSessionResult {
    if (!input.idempotencyKey.trim()) throw new RepoMindError("INVALID_INPUT", "idempotencyKey must not be empty");
    const db = this.context.database;
    const requestHash = hash(stableJson(input));
    const receipt = db.raw.prepare(
      "SELECT request_hash, result_json FROM commit_receipts WHERE session_id=? AND idempotency_key=?",
    ).get(input.sessionId, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new RepoMindError("INVALID_INPUT", "Idempotency key was reused with a different request");
      return JSON.parse(receipt.result_json) as CommitSessionResult;
    }

    const session = db.raw.prepare(
      "SELECT status, baseline_head FROM sessions WHERE id=? AND repository_id=?",
    ).get(input.sessionId, this.context.marker.projectId) as { status: string; baseline_head: string | null } | undefined;
    if (!session) throw new RepoMindError("SESSION_NOT_FOUND", `Session ${input.sessionId} was not found`);
    if (session.status !== "open") throw new RepoMindError("SESSION_NOT_OPEN", `Session ${input.sessionId} is ${session.status}`);

    const finalSnapshot = inspectGit(this.context.root);
    const diff = captureDiff(this.context.root, session.baseline_head, finalSnapshot.head);
    const files = extractFiles(finalSnapshot.status);
    const finalStatus = input.status === "success" ? "committed" : input.status;

    return db.transaction(() => {
      const evidenceIds: string[] = [];
      evidenceIds.push(this.insertEvidence(input.sessionId, "agent_summary", input.summary, { remainingWork: input.remainingWork ?? [] }, null));
      evidenceIds.push(this.insertEvidence(input.sessionId, "git_snapshot", JSON.stringify(finalSnapshot), { phase: "final" }, finalSnapshot.head));
      if (diff.content) evidenceIds.push(this.insertEvidence(input.sessionId, "git_diff", diff.content, { truncated: diff.truncated, sources: diff.sources, files }, finalSnapshot.head));

      const testEvidence = new Map<string, string>();
      for (const test of input.tests ?? []) {
        const id = this.insertEvidence(input.sessionId, "test_result", JSON.stringify(test), { exitCode: test.exitCode, command: test.command }, finalSnapshot.head);
        evidenceIds.push(id);
        testEvidence.set(test.command, id);
      }
      for (const command of input.commands ?? []) {
        evidenceIds.push(this.insertEvidence(input.sessionId, "command_result", JSON.stringify(command), { exitCode: command.exitCode, command: command.command }, finalSnapshot.head));
      }

      let stored = 0;
      let skipped = 0;
      const summaryEvidence = evidenceIds[0];
      for (const decision of input.decisions ?? []) {
        const wasStored = this.storeMemory({ type: "decision", title: titleFrom(decision, "Technical decision"), content: decision, confidence: 0.85, tags: ["decision"], relatedFiles: files }, "extracted", [summaryEvidence!]);
        wasStored ? stored++ : skipped++;
      }
      for (const test of (input.tests ?? []).filter((item) => item.exitCode === 0)) {
        const content = `${test.command}\n${test.summary}`;
        const wasStored = this.storeMemory({ type: "command", title: `Verified command: ${test.command}`, content, confidence: 0.95, tags: ["test", "verified-command"], relatedFiles: files }, "extracted", [testEvidence.get(test.command)!]);
        wasStored ? stored++ : skipped++;
      }
      if (input.status === "success" && input.summary.trim()) {
        const wasStored = this.storeMemory({ type: "solution", title: titleFrom(input.summary, "Completed solution"), content: input.summary, confidence: 0.8, tags: ["solution"], relatedFiles: files }, "extracted", evidenceIds);
        wasStored ? stored++ : skipped++;
      }

      db.raw.prepare(`
        UPDATE sessions SET status=?, final_branch=?, final_head=?, final_dirty=?, ended_at=? WHERE id=?
      `).run(finalStatus, finalSnapshot.branch, finalSnapshot.head, finalSnapshot.dirty ? 1 : 0, Date.now(), input.sessionId);
      const result: CommitSessionResult = {
        sessionId: input.sessionId,
        status: finalStatus,
        evidenceCreated: evidenceIds.length,
        memories: { stored, skipped },
      };
      db.raw.prepare(`
        INSERT INTO commit_receipts(session_id, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(input.sessionId, input.idempotencyKey, requestHash, JSON.stringify(result), Date.now());
      return result;
    });
  }

  record(input: RecordMemoryInput): { id: string; stored: boolean } {
    if (!input.title.trim() || !input.content.trim()) throw new RepoMindError("INVALID_INPUT", "title and content must not be empty");
    let id = "";
    let stored = false;
    this.context.database.transaction(() => {
      const evidenceId = this.insertEvidence(null, "manual", input.content, { title: input.title }, null);
      const result = this.storeMemory(input, "manual", [evidenceId]);
      stored = result;
      id = this.memoryIdByFingerprint(input);
    });
    return { id, stored };
  }

  search(query: string, options: { limit?: number; types?: MemoryType[]; statuses?: Array<"active" | "uncertain"> } = {}): MemoryResult[] {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
    const statuses = options.statuses ?? ["active", "uncertain"];
    const types = options.types ?? [];
    const db = this.context.database.raw;
    const conditions = ["m.repository_id = ?", `m.status IN (${statuses.map(() => "?").join(",")})`];
    const params: SqlValue[] = [this.context.marker.projectId, ...statuses];
    if (types.length) {
      conditions.push(`m.type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    const words = cleanQuery.split(/\s+/u).map((word) => word.replace(/["'*:^()]/g, "")).filter(Boolean);
    const match = words.map((word) => `"${word}"`).join(" OR ");
    let rows: Array<Record<string, unknown>> = [];
    if (match) {
      rows = db.prepare(`
        SELECT m.*, bm25(memory_fts) AS rank
        FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
        WHERE memory_fts MATCH ? AND ${conditions.join(" AND ")}
        ORDER BY rank LIMIT ?
      `).all(match, ...params, limit) as Array<Record<string, unknown>>;
    }
    if (rows.length < limit) {
      const existing = new Set(rows.map((row) => String(row.id)));
      const fallback = db.prepare(`
        SELECT m.*, 100.0 AS rank FROM memories m
        WHERE ${conditions.join(" AND ")} AND (m.title LIKE ? OR m.content LIKE ?)
        ORDER BY m.updated_at DESC LIMIT ?
      `).all(...params, `%${cleanQuery}%`, `%${cleanQuery}%`, limit) as Array<Record<string, unknown>>;
      rows.push(...fallback.filter((row) => !existing.has(String(row.id))).slice(0, limit - rows.length));
    }
    return rows.map((row) => ({
      id: String(row.id),
      type: row.type as MemoryType,
      title: String(row.title),
      content: String(row.content),
      confidence: Number(row.confidence),
      status: row.status as MemoryResult["status"],
      scopeType: row.scope_type as MemoryResult["scopeType"],
      scopeValue: row.scope_value === null ? null : String(row.scope_value),
      tags: JSON.parse(String(row.tags_json)) as string[],
      score: Number(row.rank) === 100 ? 0.25 : 1 / (1 + Math.abs(Number(row.rank))),
      ...(row.status === "uncertain" ? { warning: "This memory may be stale or conflicting." } : {}),
    }));
  }

  inspect(memoryId: string): Record<string, unknown> {
    const db = this.context.database.raw;
    const memory = db.prepare("SELECT * FROM memories WHERE id=? AND repository_id=?").get(memoryId, this.context.marker.projectId) as Record<string, unknown> | undefined;
    if (!memory) throw new RepoMindError("MEMORY_NOT_FOUND", `Memory ${memoryId} was not found`);
    const evidence = db.prepare(`
      SELECT e.id, e.kind, e.content_hash, e.file_path, e.commit_hash, e.metadata_json, e.created_at,
             substr(e.content, 1, 1000) AS content_preview
      FROM evidence e JOIN memory_evidence me ON me.evidence_id=e.id WHERE me.memory_id=? ORDER BY e.created_at
    `).all(memoryId);
    const files = db.prepare("SELECT file_path, file_hash FROM memory_files WHERE memory_id=? ORDER BY file_path").all(memoryId);
    const audit = db.prepare("SELECT action, reason, created_at FROM memory_audit_log WHERE memory_id=? ORDER BY created_at").all(memoryId);
    return { ...memory, tags: JSON.parse(String(memory.tags_json)), evidence, files, audit };
  }

  status(): Record<string, unknown> {
    const db = this.context.database.raw;
    const count = (table: string): number => Number((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE repository_id=?`).get(this.context.marker.projectId) as { count: number }).count);
    return {
      projectId: this.context.marker.projectId,
      repositoryRoot: this.context.root,
      databasePath: this.context.database.path,
      sessions: count("sessions"),
      evidence: count("evidence"),
      memories: count("memories"),
      openSessions: Number((db.prepare("SELECT count(*) AS count FROM sessions WHERE repository_id=? AND status='open'").get(this.context.marker.projectId) as { count: number }).count),
      capabilities: { fts5: true, vector: false, automaticExtraction: "deterministic" },
    };
  }

  listSessions(): unknown[] {
    return this.context.database.raw.prepare(`
      SELECT id, task, status, client_name, started_at, ended_at FROM sessions
      WHERE repository_id=? ORDER BY started_at DESC
    `).all(this.context.marker.projectId);
  }

  abandonSession(sessionId: string): void {
    const result = this.context.database.raw.prepare(`
      UPDATE sessions SET status='abandoned', ended_at=? WHERE id=? AND repository_id=? AND status='open'
    `).run(Date.now(), sessionId, this.context.marker.projectId);
    if (result.changes === 0) throw new RepoMindError("SESSION_NOT_OPEN", `Open session ${sessionId} was not found`);
  }

  private insertEvidence(sessionId: string | null, kind: EvidenceKind, content: string, metadata: Record<string, unknown>, commitHash: string | null): string {
    const id = `evd_${randomUUID()}`;
    this.context.database.raw.prepare(`
      INSERT INTO evidence(id, repository_id, session_id, kind, content, content_hash, commit_hash, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.context.marker.projectId, sessionId, kind, content, hash(content), commitHash, JSON.stringify(metadata), Date.now());
    return id;
  }

  private memoryFingerprint(input: RecordMemoryInput): string {
    return hash(stableJson({
      type: input.type,
      content: input.content.trim().toLowerCase(),
      scopeType: input.scopeType ?? "repository",
      scopeValue: input.scopeValue ?? null,
    }));
  }

  private memoryIdByFingerprint(input: RecordMemoryInput): string {
    const row = this.context.database.raw.prepare("SELECT id FROM memories WHERE repository_id=? AND fingerprint=?")
      .get(this.context.marker.projectId, this.memoryFingerprint(input)) as { id: string };
    return row.id;
  }

  private storeMemory(input: RecordMemoryInput, source: "extracted" | "manual", evidenceIds: string[]): boolean {
    const db = this.context.database.raw;
    const fingerprint = this.memoryFingerprint(input);
    const existing = db.prepare("SELECT id FROM memories WHERE repository_id=? AND fingerprint=?")
      .get(this.context.marker.projectId, fingerprint) as { id: string } | undefined;
    if (existing) {
      for (const evidenceId of evidenceIds) db.prepare("INSERT OR IGNORE INTO memory_evidence(memory_id, evidence_id) VALUES (?, ?)").run(existing.id, evidenceId);
      return false;
    }
    const id = `mem_${randomUUID()}`;
    const now = Date.now();
    const tags = [...new Set(input.tags ?? [])];
    const files = [...new Set(input.relatedFiles ?? [])];
    db.prepare(`
      INSERT INTO memories(id, repository_id, type, title, content, confidence, status, scope_type, scope_value,
        source, tags_json, fingerprint, created_at, updated_at, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.context.marker.projectId, input.type, input.title.trim(), input.content.trim(), input.confidence ?? 1,
      input.scopeType ?? "repository", input.scopeValue ?? null, source, JSON.stringify(tags), fingerprint, now, now, now);
    for (const evidenceId of evidenceIds) db.prepare("INSERT INTO memory_evidence(memory_id, evidence_id) VALUES (?, ?)").run(id, evidenceId);
    for (const file of files) {
      const absolute = resolve(this.context.root, file);
      const fileHash = existsSync(absolute) && statSync(absolute).isFile() ? hash(readFileSync(absolute)) : null;
      db.prepare("INSERT INTO memory_files(memory_id, file_path, file_hash) VALUES (?, ?, ?)").run(id, file, fileHash);
    }
    db.prepare("INSERT INTO memory_fts(memory_id, repository_id, title, content, search_tokens) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.context.marker.projectId, input.title.trim(), input.content.trim(), searchTokens(input.title, input.content, tags, files));
    db.prepare("INSERT INTO memory_audit_log(id, memory_id, action, next_json, reason, created_at) VALUES (?, ?, 'created', ?, ?, ?)")
      .run(`aud_${randomUUID()}`, id, JSON.stringify({ status: "active", source }), `${source} memory created`, now);
    return true;
  }
}
