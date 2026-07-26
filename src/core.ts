import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CommitSessionInput,
  CommitSessionResult,
  CorrectMemoryInput,
  CorrectMemoryResult,
  EvidenceKind,
  InvalidateMemoryInput,
  InvalidateMemoryResult,
  MemoryResult,
  MemoryStatusReason,
  MemoryType,
  RecordMemoryInput,
  StaleReason,
  StartSessionInput,
  StartSessionResult,
  ValidateMemoryInput,
  ValidateMemoryResult,
} from "./domain/types.js";
import { RepoMindError } from "./errors.js";
import { captureDiff, inspectGit } from "./git/git-inspector.js";
import { openRepository, type RepositoryContext } from "./repository.js";

type SqlValue = string | number | null;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseStatusReason(value: unknown): MemoryStatusReason | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MemoryStatusReason>;
    if (parsed.kind === "stale_files" && Array.isArray(parsed.files)) return parsed as MemoryStatusReason;
    if (parsed.kind === "superseded" && typeof parsed.replacementMemoryId === "string" && typeof parsed.reason === "string") return parsed as MemoryStatusReason;
    if (parsed.kind === "invalid" && typeof parsed.reason === "string") return parsed as MemoryStatusReason;
    return null;
  } catch {
    return null;
  }
}

function staleWarning(reasons: StaleReason[]): string {
  const descriptions = reasons.map((reason) => {
    if (reason.kind === "file_deleted") return `${reason.filePath} was deleted`;
    if (reason.kind === "file_created") return `${reason.filePath} was created`;
    return `${reason.filePath} changed`;
  });
  return `This memory may be stale: ${descriptions.join("; ")}.`;
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

  validateMemory(input: ValidateMemoryInput): ValidateMemoryResult {
    if (!input.memoryId.trim() || !input.reason.trim()) throw new RepoMindError("INVALID_INPUT", "memoryId and reason must not be empty");
    this.refreshStaleMemoryStates(input.memoryId);
    const db = this.context.database.raw;
    const memory = db.prepare("SELECT status, status_reason_json FROM memories WHERE id=? AND repository_id=?")
      .get(input.memoryId, this.context.marker.projectId) as { status: string; status_reason_json: string | null } | undefined;
    if (!memory) throw new RepoMindError("MEMORY_NOT_FOUND", `Memory ${input.memoryId} was not found`);
    if (memory.status !== "active" && memory.status !== "uncertain") {
      throw new RepoMindError("INVALID_INPUT", `Memory ${input.memoryId} cannot be validated while ${memory.status}`);
    }
    const files = db.prepare("SELECT file_path FROM memory_files WHERE memory_id=? ORDER BY file_path")
      .all(input.memoryId) as Array<{ file_path: string }>;
    const currentFiles = files.map((file) => ({ filePath: file.file_path, fileHash: this.currentFileHash(file.file_path) }));
    const snapshot = inspectGit(this.context.root);
    const now = Date.now();
    this.context.database.transaction(() => {
      const evidenceId = this.insertEvidence(null, "validation", input.reason.trim(), { memoryId: input.memoryId, files: currentFiles }, snapshot.head);
      for (const file of currentFiles) {
        db.prepare("UPDATE memory_files SET file_hash=? WHERE memory_id=? AND file_path=?")
          .run(file.fileHash, input.memoryId, file.filePath);
      }
      db.prepare("UPDATE memories SET status='active', status_reason_json=NULL, last_validated_at=?, updated_at=? WHERE id=?")
        .run(now, now, input.memoryId);
      db.prepare("INSERT INTO memory_evidence(memory_id, evidence_id) VALUES (?, ?)").run(input.memoryId, evidenceId);
      db.prepare(`
        INSERT INTO memory_audit_log(id, memory_id, action, previous_json, next_json, reason, created_at)
        VALUES (?, ?, 'memory_validated', ?, ?, ?, ?)
      `).run(
        `aud_${randomUUID()}`,
        input.memoryId,
        JSON.stringify({ status: memory.status, statusReason: parseStatusReason(memory.status_reason_json) }),
        JSON.stringify({ status: "active", lastValidatedAt: now, files: currentFiles }),
        input.reason.trim(),
        now,
      );
    });
    return { memoryId: input.memoryId, status: "active", lastValidatedAt: now, files: currentFiles };
  }

  correctMemory(input: CorrectMemoryInput): CorrectMemoryResult {
    if (!input.memoryId.trim() || !input.reason.trim() || !input.title.trim() || !input.content.trim()) {
      throw new RepoMindError("INVALID_INPUT", "memoryId, reason, title, and content must not be empty");
    }
    if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
      throw new RepoMindError("INVALID_INPUT", "confidence must be between 0 and 1");
    }
    this.refreshStaleMemoryStates(input.memoryId);
    const db = this.context.database.raw;
    const memory = db.prepare("SELECT * FROM memories WHERE id=? AND repository_id=?")
      .get(input.memoryId, this.context.marker.projectId) as Record<string, unknown> | undefined;
    if (!memory) throw new RepoMindError("MEMORY_NOT_FOUND", `Memory ${input.memoryId} was not found`);
    const currentStatus = String(memory.status);
    if (currentStatus !== "active" && currentStatus !== "uncertain") {
      throw new RepoMindError("INVALID_INPUT", `Memory ${input.memoryId} cannot be corrected while ${currentStatus}`);
    }
    const inheritedFiles = (db.prepare("SELECT file_path FROM memory_files WHERE memory_id=? ORDER BY file_path").all(input.memoryId) as Array<{ file_path: string }>)
      .map((file) => file.file_path);
    const replacement: RecordMemoryInput = {
      type: input.type ?? memory.type as MemoryType,
      title: input.title,
      content: input.content,
      confidence: input.confidence ?? Number(memory.confidence),
      scopeType: memory.scope_type as NonNullable<RecordMemoryInput["scopeType"]>,
      ...(memory.scope_value === null ? {} : { scopeValue: String(memory.scope_value) }),
      tags: input.tags ?? JSON.parse(String(memory.tags_json)) as string[],
      relatedFiles: input.relatedFiles ?? inheritedFiles,
    };
    if (this.memoryFingerprint(replacement) === String(memory.fingerprint)) {
      throw new RepoMindError("INVALID_INPUT", "Correction must change the memory content, type, or scope");
    }
    const snapshot = inspectGit(this.context.root);
    let replacementMemoryId = "";
    let replacementStored = false;
    this.context.database.transaction(() => {
      const evidenceId = this.insertEvidence(null, "correction", input.reason.trim(), { correctedMemoryId: input.memoryId }, snapshot.head);
      replacementStored = this.storeMemory(replacement, "manual", [evidenceId]);
      replacementMemoryId = this.memoryIdByFingerprint(replacement);
      const replacementStatus = db.prepare("SELECT status FROM memories WHERE id=? AND repository_id=?")
        .get(replacementMemoryId, this.context.marker.projectId) as { status: string } | undefined;
      if (!replacementStatus || replacementStatus.status !== "active") {
        throw new RepoMindError("INVALID_INPUT", "Correction target must be an active memory");
      }
      db.prepare("INSERT OR IGNORE INTO memory_evidence(memory_id, evidence_id) VALUES (?, ?)").run(input.memoryId, evidenceId);
      const now = Date.now();
      const statusReason: MemoryStatusReason = { kind: "superseded", replacementMemoryId, reason: input.reason.trim() };
      db.prepare("UPDATE memories SET status='superseded', status_reason_json=?, updated_at=? WHERE id=?")
        .run(stableJson(statusReason), now, input.memoryId);
      db.prepare(`
        INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, created_at)
        VALUES (?, ?, 'supersedes', ?)
      `).run(replacementMemoryId, input.memoryId, now);
      db.prepare(`
        INSERT INTO memory_audit_log(id, memory_id, action, previous_json, next_json, reason, created_at)
        VALUES (?, ?, 'memory_corrected', ?, ?, ?, ?)
      `).run(
        `aud_${randomUUID()}`,
        input.memoryId,
        JSON.stringify({ status: currentStatus, statusReason: parseStatusReason(memory.status_reason_json) }),
        JSON.stringify({ status: "superseded", statusReason }),
        input.reason.trim(),
        now,
      );
    });
    return { memoryId: input.memoryId, status: "superseded", replacementMemoryId, replacementStored };
  }

  invalidateMemory(input: InvalidateMemoryInput): InvalidateMemoryResult {
    if (!input.memoryId.trim() || !input.reason.trim()) throw new RepoMindError("INVALID_INPUT", "memoryId and reason must not be empty");
    this.refreshStaleMemoryStates(input.memoryId);
    const db = this.context.database.raw;
    const memory = db.prepare("SELECT status, status_reason_json FROM memories WHERE id=? AND repository_id=?")
      .get(input.memoryId, this.context.marker.projectId) as { status: string; status_reason_json: string | null } | undefined;
    if (!memory) throw new RepoMindError("MEMORY_NOT_FOUND", `Memory ${input.memoryId} was not found`);
    if (memory.status !== "active" && memory.status !== "uncertain") {
      throw new RepoMindError("INVALID_INPUT", `Memory ${input.memoryId} cannot be invalidated while ${memory.status}`);
    }
    const snapshot = inspectGit(this.context.root);
    const now = Date.now();
    const statusReason: MemoryStatusReason = { kind: "invalid", reason: input.reason.trim() };
    this.context.database.transaction(() => {
      const evidenceId = this.insertEvidence(null, "invalidation", input.reason.trim(), { memoryId: input.memoryId }, snapshot.head);
      db.prepare("INSERT INTO memory_evidence(memory_id, evidence_id) VALUES (?, ?)").run(input.memoryId, evidenceId);
      db.prepare("UPDATE memories SET status='invalid', status_reason_json=?, updated_at=? WHERE id=?")
        .run(stableJson(statusReason), now, input.memoryId);
      db.prepare(`
        INSERT INTO memory_audit_log(id, memory_id, action, previous_json, next_json, reason, created_at)
        VALUES (?, ?, 'memory_invalidated', ?, ?, ?, ?)
      `).run(
        `aud_${randomUUID()}`,
        input.memoryId,
        JSON.stringify({ status: memory.status, statusReason: parseStatusReason(memory.status_reason_json) }),
        JSON.stringify({ status: "invalid", statusReason }),
        input.reason.trim(),
        now,
      );
    });
    return { memoryId: input.memoryId, status: "invalid" };
  }

  search(query: string, options: { limit?: number; types?: MemoryType[]; statuses?: Array<"active" | "uncertain"> } = {}): MemoryResult[] {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    this.refreshStaleMemoryStates();
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
    return rows.map((row) => {
      const statusReason = parseStatusReason(row.status_reason_json);
      const staleReason = statusReason?.kind === "stale_files" ? statusReason : null;
      return {
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
        ...(row.status === "uncertain"
          ? {
              warning: staleReason ? staleWarning(staleReason.files) : "This memory may be stale or conflicting.",
              ...(staleReason ? { staleReasons: staleReason.files } : {}),
            }
          : {}),
      };
    });
  }

  inspect(memoryId: string): Record<string, unknown> {
    this.refreshStaleMemoryStates(memoryId);
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
    const relations = db.prepare(`
      SELECT 'outgoing' AS direction, relation_type, target_memory_id AS related_memory_id, created_at
      FROM memory_relations WHERE source_memory_id=?
      UNION ALL
      SELECT 'incoming' AS direction, relation_type, source_memory_id AS related_memory_id, created_at
      FROM memory_relations WHERE target_memory_id=?
      ORDER BY created_at
    `).all(memoryId, memoryId);
    const statusReason = parseStatusReason(memory.status_reason_json);
    const staleReason = statusReason?.kind === "stale_files" ? statusReason : null;
    return {
      ...memory,
      tags: JSON.parse(String(memory.tags_json)),
      statusReason,
      ...(staleReason ? { warning: staleWarning(staleReason.files) } : {}),
      evidence,
      files,
      relations,
      audit,
    };
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
      uncertainMemories: Number((db.prepare("SELECT count(*) AS count FROM memories WHERE repository_id=? AND status='uncertain'").get(this.context.marker.projectId) as { count: number }).count),
      supersededMemories: Number((db.prepare("SELECT count(*) AS count FROM memories WHERE repository_id=? AND status='superseded'").get(this.context.marker.projectId) as { count: number }).count),
      invalidMemories: Number((db.prepare("SELECT count(*) AS count FROM memories WHERE repository_id=? AND status='invalid'").get(this.context.marker.projectId) as { count: number }).count),
      openSessions: Number((db.prepare("SELECT count(*) AS count FROM sessions WHERE repository_id=? AND status='open'").get(this.context.marker.projectId) as { count: number }).count),
      capabilities: {
        fts5: true,
        vector: false,
        automaticExtraction: "deterministic",
        staleDetection: "file-hash",
        governance: ["validate", "correct", "invalidate"],
      },
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

  private currentFileHash(filePath: string): string | null {
    const absolute = resolve(this.context.root, filePath);
    const fromRoot = relative(this.context.root, absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
    try {
      return existsSync(absolute) && statSync(absolute).isFile() ? hash(readFileSync(absolute)) : null;
    } catch {
      return null;
    }
  }

  private refreshStaleMemoryStates(memoryId?: string): void {
    const db = this.context.database.raw;
    const rows = db.prepare(`
      SELECT m.id, m.status, m.status_reason_json, mf.file_path, mf.file_hash
      FROM memories m JOIN memory_files mf ON mf.memory_id=m.id
      WHERE m.repository_id=? AND m.status IN ('active','uncertain')${memoryId ? " AND m.id=?" : ""}
      ORDER BY m.id, mf.file_path
    `).all(this.context.marker.projectId, ...(memoryId ? [memoryId] : [])) as Array<{
      id: string;
      status: string;
      status_reason_json: string | null;
      file_path: string;
      file_hash: string | null;
    }>;
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.id) ?? [];
      group.push(row);
      grouped.set(row.id, group);
    }

    const updates: Array<{ id: string; previousStatus: string; previousReason: string | null; reason: MemoryStatusReason & { kind: "stale_files" } }> = [];
    for (const [id, files] of grouped) {
      const first = files[0]!;
      const existingReason = parseStatusReason(first.status_reason_json);
      if (first.status === "uncertain" && existingReason?.kind !== "stale_files") continue;
      const staleFiles: StaleReason[] = [];
      for (const file of files) {
        const currentHash = this.currentFileHash(file.file_path);
        let kind: StaleReason["kind"] | null = null;
        if (file.file_hash && !currentHash) kind = "file_deleted";
        else if (!file.file_hash && currentHash) kind = "file_created";
        else if (file.file_hash && currentHash && file.file_hash !== currentHash) kind = "file_modified";
        if (kind) staleFiles.push({ kind, filePath: file.file_path, expectedHash: file.file_hash, currentHash });
      }
      if (!staleFiles.length) continue;
      const reason = { kind: "stale_files" as const, files: staleFiles };
      if (first.status === "uncertain" && stableJson(existingReason) === stableJson(reason)) continue;
      updates.push({ id, previousStatus: first.status, previousReason: first.status_reason_json, reason });
    }

    if (!updates.length) return;
    this.context.database.transaction(() => {
      for (const update of updates) {
        const now = Date.now();
        const reasonJson = stableJson(update.reason);
        db.prepare("UPDATE memories SET status='uncertain', status_reason_json=?, updated_at=? WHERE id=?")
          .run(reasonJson, now, update.id);
        db.prepare(`
          INSERT INTO memory_audit_log(id, memory_id, action, previous_json, next_json, reason, created_at)
          VALUES (?, ?, 'memory_marked_uncertain', ?, ?, ?, ?)
        `).run(
          `aud_${randomUUID()}`,
          update.id,
          JSON.stringify({ status: update.previousStatus, statusReason: parseStatusReason(update.previousReason) }),
          JSON.stringify({ status: "uncertain", statusReason: update.reason }),
          staleWarning(update.reason.files),
          now,
        );
      }
    });
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
      const fileHash = this.currentFileHash(file);
      db.prepare("INSERT INTO memory_files(memory_id, file_path, file_hash) VALUES (?, ?, ?)").run(id, file, fileHash);
    }
    db.prepare("INSERT INTO memory_fts(memory_id, repository_id, title, content, search_tokens) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.context.marker.projectId, input.title.trim(), input.content.trim(), searchTokens(input.title, input.content, tags, files));
    db.prepare("INSERT INTO memory_audit_log(id, memory_id, action, next_json, reason, created_at) VALUES (?, ?, 'created', ?, ?, ?)")
      .run(`aud_${randomUUID()}`, id, JSON.stringify({ status: "active", source }), `${source} memory created`, now);
    return true;
  }
}
