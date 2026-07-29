import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { databasePath, readProjectMarker } from "../config/paths.js";
import { RepoMindError } from "../errors.js";
import { locateGitRoot } from "../git/git-inspector.js";
import type { RepositoryContext } from "../repository.js";
import { searchTokens } from "../search/lexical.js";
import { redactDeep } from "../security/redaction.js";
import { Database } from "../storage/database.js";
import { migrations } from "../storage/migrations.js";

type JsonScalar = string | number | null;
type ExportRow = Record<string, JsonScalar>;

interface TableDefinition {
  columns: readonly string[];
  select: string;
  repositoryColumn?: string;
  checkoutColumn?: string;
}

const FORMAT = "repomind-repository-export";
const FORMAT_VERSION = 2;
const BACKUP_FORMAT = "repomind-sqlite-backup";
const BACKUP_FORMAT_VERSION = 1;
const CURRENT_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

const TABLES = {
  sessions: {
    columns: ["id", "repository_id", "checkout_id", "client_name", "client_session_id", "task", "status", "baseline_branch", "baseline_head", "final_branch", "final_head", "baseline_dirty", "final_dirty", "started_at", "ended_at"],
    select: "SELECT * FROM sessions WHERE repository_id=? ORDER BY started_at, id",
    repositoryColumn: "repository_id",
    checkoutColumn: "checkout_id",
  },
  evidence: {
    columns: ["id", "repository_id", "session_id", "kind", "content", "content_hash", "file_path", "file_hash", "commit_hash", "metadata_json", "created_at"],
    select: "SELECT * FROM evidence WHERE repository_id=? ORDER BY created_at, id",
    repositoryColumn: "repository_id",
  },
  memories: {
    columns: ["id", "repository_id", "type", "title", "content", "confidence", "status", "scope_type", "scope_value", "source", "tags_json", "fingerprint", "created_at", "updated_at", "last_validated_at", "status_reason_json"],
    select: "SELECT * FROM memories WHERE repository_id=? ORDER BY created_at, id",
    repositoryColumn: "repository_id",
  },
  memory_evidence: {
    columns: ["memory_id", "evidence_id"],
    select: "SELECT me.* FROM memory_evidence me JOIN memories m ON m.id=me.memory_id WHERE m.repository_id=? ORDER BY me.memory_id, me.evidence_id",
  },
  memory_files: {
    columns: ["memory_id", "file_path", "file_hash", "file_size", "file_mtime_ms"],
    select: "SELECT mf.* FROM memory_files mf JOIN memories m ON m.id=mf.memory_id WHERE m.repository_id=? ORDER BY mf.memory_id, mf.file_path",
  },
  memory_audit_log: {
    columns: ["id", "memory_id", "action", "previous_json", "next_json", "reason", "created_at"],
    select: "SELECT a.* FROM memory_audit_log a JOIN memories m ON m.id=a.memory_id WHERE m.repository_id=? ORDER BY a.created_at, a.id",
  },
  memory_relations: {
    columns: ["source_memory_id", "target_memory_id", "relation_type", "created_at"],
    select: "SELECT r.* FROM memory_relations r JOIN memories m ON m.id=r.source_memory_id WHERE m.repository_id=? ORDER BY r.created_at, r.source_memory_id, r.target_memory_id",
  },
  commit_receipts: {
    columns: ["session_id", "idempotency_key", "request_hash", "result_json", "created_at"],
    select: "SELECT r.* FROM commit_receipts r JOIN sessions s ON s.id=r.session_id WHERE s.repository_id=? ORDER BY r.created_at, r.session_id",
  },
  forget_log: {
    columns: ["id", "repository_id", "memory_id", "memory_type", "scope", "evidence_deleted", "reason", "created_at"],
    select: "SELECT * FROM forget_log WHERE repository_id=? ORDER BY created_at, id",
    repositoryColumn: "repository_id",
  },
  host_runs: {
    columns: ["id", "repository_id", "session_id", "task", "runner", "model", "output_directory", "report_path", "status", "agent_exit_code", "agent_signal", "retrieved_memories", "duration_ms", "input_tokens", "output_tokens", "repo_mind_calls", "error", "metadata_json", "started_at", "ended_at"],
    select: "SELECT * FROM host_runs WHERE repository_id=? ORDER BY started_at, id",
    repositoryColumn: "repository_id",
  },
  module_narratives: {
    columns: ["id", "repository_id", "module_path", "title", "content", "source_fingerprint", "source_count", "budget_chars", "version", "created_at", "updated_at"],
    select: "SELECT * FROM module_narratives WHERE repository_id=? ORDER BY module_path, id",
    repositoryColumn: "repository_id",
  },
  module_narrative_sources: {
    columns: ["narrative_id", "memory_id", "sort_order"],
    select: "SELECT ns.* FROM module_narrative_sources ns JOIN module_narratives n ON n.id=ns.narrative_id WHERE n.repository_id=? ORDER BY ns.narrative_id, ns.sort_order",
  },
  repository_profiles: {
    columns: ["id", "repository_id", "title", "content", "source_fingerprint", "memory_source_count", "module_source_count", "budget_chars", "min_confidence", "version", "created_at", "updated_at"],
    select: "SELECT * FROM repository_profiles WHERE repository_id=? ORDER BY id",
    repositoryColumn: "repository_id",
  },
  repository_profile_memory_sources: {
    columns: ["profile_id", "memory_id", "sort_order"],
    select: "SELECT ps.* FROM repository_profile_memory_sources ps JOIN repository_profiles p ON p.id=ps.profile_id WHERE p.repository_id=? ORDER BY ps.profile_id, ps.sort_order",
  },
  repository_profile_module_sources: {
    columns: ["profile_id", "narrative_id", "sort_order"],
    select: "SELECT ps.* FROM repository_profile_module_sources ps JOIN repository_profiles p ON p.id=ps.profile_id WHERE p.repository_id=? ORDER BY ps.profile_id, ps.sort_order",
  },
  repository_profile_versions: {
    columns: ["profile_id", "version", "content", "source_fingerprint", "memory_ids_json", "narrative_ids_json", "created_at"],
    select: "SELECT v.* FROM repository_profile_versions v JOIN repository_profiles p ON p.id=v.profile_id WHERE p.repository_id=? ORDER BY v.profile_id, v.version",
  },
  skill_candidates: {
    columns: ["id", "repository_id", "workflow_key", "title", "trigger_text", "inputs_json", "steps_json", "verification_json", "risks_json", "source_fingerprint", "source_session_count", "status", "review_reason", "created_at", "updated_at", "reviewed_at"],
    select: "SELECT * FROM skill_candidates WHERE repository_id=? ORDER BY created_at, id",
    repositoryColumn: "repository_id",
  },
  skill_candidate_sessions: {
    columns: ["candidate_id", "session_id", "sort_order"],
    select: "SELECT cs.* FROM skill_candidate_sessions cs JOIN skill_candidates c ON c.id=cs.candidate_id WHERE c.repository_id=? ORDER BY cs.candidate_id, cs.sort_order",
  },
  skill_candidate_evidence: {
    columns: ["candidate_id", "evidence_id"],
    select: "SELECT ce.* FROM skill_candidate_evidence ce JOIN skill_candidates c ON c.id=ce.candidate_id WHERE c.repository_id=? ORDER BY ce.candidate_id, ce.evidence_id",
  },
  skill_candidate_audit_log: {
    columns: ["id", "candidate_id", "action", "previous_status", "next_status", "reason", "metadata_json", "created_at"],
    select: "SELECT a.* FROM skill_candidate_audit_log a JOIN skill_candidates c ON c.id=a.candidate_id WHERE c.repository_id=? ORDER BY a.created_at, a.id",
  },
} as const satisfies Record<string, TableDefinition>;

type TableName = keyof typeof TABLES;

const TABLE_ORDER = Object.keys(TABLES) as TableName[];
const V1_TABLE_ORDER = TABLE_ORDER.filter((table) => !table.startsWith("skill_candidate"));

const exportEnvelopeSchema = z.object({
  format: z.literal(FORMAT),
  formatVersion: z.union([z.literal(1), z.literal(FORMAT_VERSION)]),
  exportedAt: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive().max(CURRENT_SCHEMA_VERSION),
  repository: z.object({ projectId: z.string().min(1), name: z.string().min(1) }).strict(),
  tables: z.record(z.array(z.record(z.union([z.string(), z.number(), z.null()])))),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  createdAt: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  schemaVersion: z.number().int().positive().max(CURRENT_SCHEMA_VERSION),
  databaseFile: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export interface RepositoryExportBundle {
  format: typeof FORMAT;
  formatVersion: 1 | typeof FORMAT_VERSION;
  exportedAt: number;
  schemaVersion: number;
  repository: { projectId: string; name: string };
  tables: Record<TableName, ExportRow[]>;
  checksum: string;
}

export interface ExportRepositoryOptions {
  allowSensitive?: boolean;
}

export interface ImportRepositoryOptions {
  allowSensitive?: boolean;
  dryRun?: boolean;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: number;
  projectId: string;
  schemaVersion: number;
  databaseFile: string;
  sizeBytes: number;
  sha256: string;
}

export interface RestoreRepositoryOptions {
  dryRun?: boolean;
  allowUnreadable?: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlPath(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

function assertNewFile(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) throw new RepoMindError("INVALID_INPUT", `Refusing to overwrite existing file ${resolved}`);
  if (!existsSync(dirname(resolved))) throw new RepoMindError("INVALID_INPUT", `Output directory does not exist: ${dirname(resolved)}`);
  return resolved;
}

function writeAtomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
}

function exportPayload(bundle: Omit<RepositoryExportBundle, "checksum">): string {
  return stableJson(bundle);
}

function validateRows(tables: Record<string, ExportRow[]>, formatVersion: 1 | typeof FORMAT_VERSION): Record<TableName, ExportRow[]> {
  const actualNames = Object.keys(tables).sort();
  const expectedOrder = formatVersion === 1 ? V1_TABLE_ORDER : TABLE_ORDER;
  const expectedNames = [...expectedOrder].sort();
  if (stableJson(actualNames) !== stableJson(expectedNames)) {
    throw new RepoMindError("INVALID_INPUT", "Export contains missing or unknown tables", { expectedNames, actualNames });
  }
  for (const tableName of expectedOrder) {
    const expectedColumns = [...TABLES[tableName].columns].sort();
    for (const [index, row] of tables[tableName]!.entries()) {
      const actualColumns = Object.keys(row).sort();
      if (stableJson(actualColumns) !== stableJson(expectedColumns)) {
        throw new RepoMindError("INVALID_INPUT", `Invalid columns in ${tableName} row ${index}`, { expectedColumns, actualColumns });
      }
    }
  }
  return Object.fromEntries(TABLE_ORDER.map((tableName) => [tableName, tables[tableName] ?? []])) as Record<TableName, ExportRow[]>;
}

export function loadRepositoryExport(path: string): RepositoryExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Could not read export ${resolve(path)}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = exportEnvelopeSchema.safeParse(parsed);
  if (!result.success) throw new RepoMindError("INVALID_INPUT", "Invalid repository export", { issues: result.error.issues });
  const { checksum, ...payload } = result.data;
  const actualChecksum = sha256(exportPayload(payload as Omit<RepositoryExportBundle, "checksum">));
  if (actualChecksum !== checksum) {
    throw new RepoMindError("INVALID_INPUT", "Repository export checksum does not match", { expected: checksum, actual: actualChecksum });
  }
  const tables = validateRows(result.data.tables as Record<string, ExportRow[]>, result.data.formatVersion);
  return { ...result.data, tables } as RepositoryExportBundle;
}

function tableCounts(tables: Record<TableName, ExportRow[]>): Record<TableName, number> {
  return Object.fromEntries(TABLE_ORDER.map((table) => [table, tables[table].length])) as Record<TableName, number>;
}

function sensitiveCount(value: unknown): number {
  return redactDeep(value).redactions;
}

export function exportRepository(
  context: RepositoryContext,
  outputPath: string,
  options: ExportRepositoryOptions = {},
): { path: string; checksum: string; sensitiveFindings: number; counts: Record<TableName, number> } {
  const output = assertNewFile(outputPath);
  const db = context.database.raw;
  const tables = context.database.transaction(() => {
    assertNoActiveWork(context);
    return Object.fromEntries(TABLE_ORDER.map((tableName) => [
      tableName,
      db.prepare(TABLES[tableName].select).all(context.marker.projectId) as ExportRow[],
    ])) as Record<TableName, ExportRow[]>;
  });
  const payload: Omit<RepositoryExportBundle, "checksum"> = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: Date.now(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    repository: { projectId: context.marker.projectId, name: context.marker.name },
    tables,
  };
  const sensitiveFindings = sensitiveCount(payload);
  if (sensitiveFindings > 0 && !options.allowSensitive) {
    throw new RepoMindError("INVALID_INPUT", "Export may contain sensitive values; inspect the repository data and re-run with --allow-sensitive to confirm", {
      sensitiveFindings,
    });
  }
  const checksum = sha256(exportPayload(payload));
  writeAtomicJson(output, { ...payload, checksum });
  return { path: output, checksum, sensitiveFindings, counts: tableCounts(tables) };
}

function insertRows(context: RepositoryContext, tableName: TableName, rows: ExportRow[]): void {
  const definition: TableDefinition = TABLES[tableName];
  const placeholders = definition.columns.map(() => "?").join(",");
  const statement = context.database.raw.prepare(
    `INSERT INTO ${tableName}(${definition.columns.join(",")}) VALUES (${placeholders})`,
  );
  for (const row of rows) {
    const mapped = { ...row };
    if (definition.repositoryColumn) mapped[definition.repositoryColumn] = context.marker.projectId;
    if (definition.checkoutColumn) mapped[definition.checkoutColumn] = context.checkoutId;
    statement.run(...definition.columns.map((column) => mapped[column] ?? null));
  }
}

function assertNoActiveWork(context: RepositoryContext): void {
  const active = context.database.raw.prepare(`
    SELECT
      (SELECT count(*) FROM sessions WHERE repository_id=? AND status='open') AS open_sessions,
      (SELECT count(*) FROM host_runs WHERE repository_id=? AND status='running') AS running_host_runs
  `).get(context.marker.projectId, context.marker.projectId) as { open_sessions: number; running_host_runs: number };
  if (Number(active.open_sessions) > 0 || Number(active.running_host_runs) > 0) {
    throw new RepoMindError("INVALID_INPUT", "Import or restore requires no open sessions or running host runs", {
      openSessions: Number(active.open_sessions), runningHostRuns: Number(active.running_host_runs),
    });
  }
}

export function importRepository(
  context: RepositoryContext,
  inputPath: string,
  options: ImportRepositoryOptions = {},
): { imported: boolean; sourceProjectId: string; targetProjectId: string; checksum: string; sensitiveFindings: number; counts: Record<TableName, number> } {
  const bundle = loadRepositoryExport(inputPath);
  const sensitiveFindings = sensitiveCount(bundle.tables);
  if (sensitiveFindings > 0 && !options.allowSensitive) {
    throw new RepoMindError("INVALID_INPUT", "Import may contain sensitive values; inspect the export and re-run with --allow-sensitive to confirm", {
      sensitiveFindings,
    });
  }
  assertNoActiveWork(context);
  if (bundle.tables.sessions.some((row) => row.status === "open") || bundle.tables.host_runs.some((row) => row.status === "running")) {
    throw new RepoMindError("INVALID_INPUT", "Repository export contains an open session or running host run");
  }
  const result = {
    imported: !options.dryRun,
    sourceProjectId: bundle.repository.projectId,
    targetProjectId: context.marker.projectId,
    checksum: bundle.checksum,
    sensitiveFindings,
    counts: tableCounts(bundle.tables),
  };
  if (options.dryRun) return result;

  const db = context.database.raw;
  context.database.transaction(() => {
    assertNoActiveWork(context);
    db.prepare("DELETE FROM skill_candidates WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM repository_profiles WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM module_narratives WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM memories WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM sessions WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM evidence WHERE repository_id=?").run(context.marker.projectId);
    db.prepare("DELETE FROM forget_log WHERE repository_id=?").run(context.marker.projectId);
    for (const tableName of TABLE_ORDER) insertRows(context, tableName, bundle.tables[tableName]);
    db.prepare("UPDATE repositories SET updated_at=? WHERE id=?").run(Date.now(), context.marker.projectId);
    db.prepare("DELETE FROM memory_fts WHERE repository_id=?").run(context.marker.projectId);
    const memoryRows = db.prepare("SELECT id, title, content, tags_json FROM memories WHERE repository_id=? ORDER BY id")
      .all(context.marker.projectId) as Array<{ id: string; title: string; content: string; tags_json: string }>;
    const insertMemoryFts = db.prepare(
      "INSERT INTO memory_fts(memory_id, repository_id, title, content, search_tokens) VALUES (?, ?, ?, ?, ?)",
    );
    for (const memory of memoryRows) {
      const files = (db.prepare("SELECT file_path FROM memory_files WHERE memory_id=? ORDER BY file_path").all(memory.id) as Array<{ file_path: string }>)
        .map((row) => row.file_path);
      insertMemoryFts.run(memory.id, context.marker.projectId, memory.title, memory.content,
        searchTokens(memory.title, memory.content, JSON.parse(memory.tags_json) as string[], files));
    }
    db.prepare("DELETE FROM module_narrative_fts WHERE repository_id=?").run(context.marker.projectId);
    db.prepare(`
      INSERT INTO module_narrative_fts(narrative_id, repository_id, module_path, title, content)
      SELECT id, repository_id, module_path, title, content FROM module_narratives WHERE repository_id=?
    `).run(context.marker.projectId);
  });
  return result;
}

function databaseMetadata(path: string): { projectIds: string[]; schemaVersion: number; openSessions: number; runningHostRuns: number } {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`integrity_check returned ${integrity.integrity_check}`);
    const projectIds = (database.prepare("SELECT id FROM repositories ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    const schema = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number | null };
    const active = database.prepare(`
      SELECT
        (SELECT count(*) FROM sessions WHERE status='open') AS open_sessions,
        (SELECT count(*) FROM host_runs WHERE status='running') AS running_host_runs
    `).get() as { open_sessions: number; running_host_runs: number };
    return {
      projectIds,
      schemaVersion: Number(schema.version ?? 0),
      openSessions: Number(active.open_sessions),
      runningHostRuns: Number(active.running_host_runs),
    };
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Invalid RepoMind backup ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    database?.close();
  }
}

function createManifest(databaseFile: string, projectId: string, createdAt = Date.now()): BackupManifest {
  const metadata = databaseMetadata(databaseFile);
  if (!metadata.projectIds.includes(projectId)) {
    throw new RepoMindError("INVALID_INPUT", `Backup does not contain project ${projectId}`);
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    projectId,
    schemaVersion: metadata.schemaVersion,
    databaseFile: databaseFile.split(/[\\/]/u).at(-1)!,
    sizeBytes: statSync(databaseFile).size,
    sha256: sha256(readFileSync(databaseFile)),
  };
}

export function backupManifestPath(databaseFile: string): string {
  return `${resolve(databaseFile)}.manifest.json`;
}

export function backupRepository(
  context: RepositoryContext,
  outputPath: string,
): { path: string; manifestPath: string; sha256: string; sizeBytes: number; schemaVersion: number } {
  const output = assertNewFile(outputPath);
  if (output === resolve(context.database.path)) throw new RepoMindError("INVALID_INPUT", "Backup output must differ from the live database");
  const manifestPath = assertNewFile(backupManifestPath(output));
  const temporary = `${output}.tmp-${randomUUID()}`;
  let transactionOpen = false;
  try {
    context.database.raw.exec("PRAGMA locking_mode=EXCLUSIVE");
    context.database.raw.exec("BEGIN EXCLUSIVE");
    transactionOpen = true;
    assertNoActiveWork(context);
    context.database.raw.exec("COMMIT");
    transactionOpen = false;
    context.database.raw.exec(`VACUUM INTO ${sqlPath(temporary)}`);
    const manifest = createManifest(temporary, context.marker.projectId);
    renameSync(temporary, output);
    writeAtomicJson(manifestPath, { ...manifest, databaseFile: output.split(/[\\/]/u).at(-1)! });
    return { path: output, manifestPath, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, schemaVersion: manifest.schemaVersion };
  } catch (error) {
    if (transactionOpen) context.database.raw.exec("ROLLBACK");
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    if (existsSync(output) && !existsSync(manifestPath)) rmSync(output, { force: true });
    throw error;
  } finally {
    context.database.raw.exec("PRAGMA locking_mode=NORMAL");
  }
}

export function loadBackupManifest(databaseFile: string): BackupManifest {
  const path = backupManifestPath(databaseFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Backup manifest was not found or is invalid: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = backupManifestSchema.safeParse(parsed);
  if (!result.success) throw new RepoMindError("INVALID_INPUT", "Invalid backup manifest", { issues: result.error.issues });
  const input = resolve(databaseFile);
  const actualHash = sha256(readFileSync(input));
  const actualSize = statSync(input).size;
  if (result.data.sha256 !== actualHash || result.data.sizeBytes !== actualSize) {
    throw new RepoMindError("INVALID_INPUT", "Backup checksum or size does not match its manifest", {
      expectedSha256: result.data.sha256, actualSha256: actualHash,
      expectedSizeBytes: result.data.sizeBytes, actualSizeBytes: actualSize,
    });
  }
  const metadata = databaseMetadata(input);
  if (!metadata.projectIds.includes(result.data.projectId) || metadata.schemaVersion !== result.data.schemaVersion) {
    throw new RepoMindError("INVALID_INPUT", "Backup database metadata does not match its manifest");
  }
  if (metadata.openSessions > 0 || metadata.runningHostRuns > 0) {
    throw new RepoMindError("INVALID_INPUT", "Backup contains an open session or running host run", {
      openSessions: metadata.openSessions, runningHostRuns: metadata.runningHostRuns,
    });
  }
  return result.data;
}

function moveIfExists(source: string, target: string): void {
  if (existsSync(source)) renameSync(source, target);
}

export function restoreRepository(
  repositoryPath: string,
  inputPath: string,
  options: RestoreRepositoryOptions = {},
): {
  restored: boolean;
  projectId: string;
  inputPath: string;
  preRestoreBackup: string | null;
  schemaVersion: number;
  previousDatabase: "ready" | "missing" | "unreadable";
} {
  const root = locateGitRoot(repositoryPath);
  const marker = readProjectMarker(root);
  const input = resolve(inputPath);
  const manifest = loadBackupManifest(input);
  if (manifest.projectId !== marker.projectId) {
    throw new RepoMindError("INVALID_INPUT", "Physical restore requires the same Project ID; use logical import to migrate into another repository", {
      backupProjectId: manifest.projectId, targetProjectId: marker.projectId,
    });
  }
  const livePath = databasePath(marker.projectId);
  if (input === resolve(livePath)) throw new RepoMindError("INVALID_INPUT", "Restore input must differ from the live database");
  let previousDatabase: "ready" | "missing" | "unreadable" = existsSync(livePath) ? "ready" : "missing";
  if (previousDatabase === "ready") {
    let currentMetadata: ReturnType<typeof databaseMetadata> | null = null;
    try {
      currentMetadata = databaseMetadata(livePath);
    } catch (error) {
      previousDatabase = "unreadable";
      if (!options.allowUnreadable) {
        throw new RepoMindError("STORAGE_UNAVAILABLE", "The live database could not be validated; resolve the storage error or re-run with --allow-unreadable to preserve and replace it", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (currentMetadata) {
      if (!currentMetadata.projectIds.includes(marker.projectId)) {
        throw new RepoMindError("STORAGE_UNAVAILABLE", "The live database does not contain the repository marker Project ID");
      }
      if (currentMetadata.openSessions > 0 || currentMetadata.runningHostRuns > 0) {
        throw new RepoMindError("INVALID_INPUT", "Import or restore requires no open sessions or running host runs", {
          openSessions: currentMetadata.openSessions,
          runningHostRuns: currentMetadata.runningHostRuns,
        });
      }
    }
  }
  if (options.dryRun) {
    return {
      restored: false,
      projectId: marker.projectId,
      inputPath: input,
      preRestoreBackup: null,
      schemaVersion: manifest.schemaVersion,
      previousDatabase,
    };
  }

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const preRestoreBackup = previousDatabase === "missing"
    ? null
    : `${livePath}.pre-restore-${suffix}${previousDatabase === "unreadable" ? ".unreadable" : ""}.db`;
  const staged = `${livePath}.restore-${suffix}.tmp`;
  const displaced = `${livePath}.restore-${suffix}.previous`;
  const liveWal = `${livePath}-wal`;
  const liveShm = `${livePath}-shm`;
  const displacedWal = `${displaced}-wal`;
  const displacedShm = `${displaced}-shm`;
  let liveDisplaced = false;
  try {
    if (previousDatabase === "ready" && preRestoreBackup) {
      const snapshot = new Database(livePath);
      try {
        snapshot.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        snapshot.raw.exec(`VACUUM INTO ${sqlPath(preRestoreBackup)}`);
      } finally {
        snapshot.close();
      }
      const preManifest = createManifest(preRestoreBackup, marker.projectId);
      writeAtomicJson(backupManifestPath(preRestoreBackup), preManifest);
    } else if (previousDatabase === "unreadable" && preRestoreBackup) {
      copyFileSync(livePath, preRestoreBackup);
    }

    copyFileSync(input, staged);
    const stagedDatabase = new Database(staged);
    try {
      const stagedMetadata = databaseMetadata(staged);
      if (!stagedMetadata.projectIds.includes(marker.projectId)) throw new Error("staged backup lost the target project");
    } finally {
      stagedDatabase.close();
    }

    if (existsSync(livePath)) {
      renameSync(livePath, displaced);
      liveDisplaced = true;
      moveIfExists(liveWal, displacedWal);
      moveIfExists(liveShm, displacedShm);
    }
    renameSync(staged, livePath);
    const restored = new Database(livePath);
    restored.close();
    rmSync(displaced, { force: true });
    rmSync(displacedWal, { force: true });
    rmSync(displacedShm, { force: true });
    return {
      restored: true,
      projectId: marker.projectId,
      inputPath: input,
      preRestoreBackup,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      previousDatabase,
    };
  } catch (error) {
    if (liveDisplaced) {
      if (existsSync(livePath)) rmSync(livePath, { force: true });
      if (existsSync(liveWal)) rmSync(liveWal, { force: true });
      if (existsSync(liveShm)) rmSync(liveShm, { force: true });
      renameSync(displaced, livePath);
      moveIfExists(displacedWal, liveWal);
      moveIfExists(displacedShm, liveShm);
    }
    if (existsSync(staged)) rmSync(staged, { force: true });
    throw error;
  }
}
