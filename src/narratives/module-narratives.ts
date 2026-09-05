import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  MemoryType,
  ModuleNarrativeDetails,
  ModuleNarrativeSource,
  ModuleNarrativeSummary,
  RebuildModuleNarrativesInput,
  RebuildModuleNarrativesResult,
} from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import type { RepositoryContext } from "../repository.js";
import { buildMatchExpression } from "../search/lexical.js";

interface SourceMemory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  status: "active" | "uncertain";
  carriedStale: boolean;
  confidence: number;
  fingerprint: string;
  updatedAt: number;
  lastValidatedAt: number | null;
  evidenceCount: number;
  files: string[];
  modules: string[];
}

interface NarrativeRow {
  id: string;
  module_path: string;
  title: string;
  content: string;
  source_fingerprint: string;
  source_count: number;
  budget_chars: number;
  version: number;
  created_at: number;
  updated_at: number;
}

const DEFAULT_BUDGET = 4_000;
const MIN_BUDGET = 500;
const MAX_BUDGET = 20_000;
const NARRATIVE_RENDER_VERSION = 3;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeModule(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized.split("/").some((part) => part === "..")) throw new RepoMindError("INVALID_INPUT", `Invalid module path ${value}`);
  return normalized;
}

function moduleFromFile(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalizeModule(posix.dirname(normalized));
}

function clip(value: string, max = 280): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function sourceFingerprint(sources: SourceMemory[]): string {
  return sha256(JSON.stringify({
    renderVersion: NARRATIVE_RENDER_VERSION,
    sources: sources.map((source) => [
      source.id,
      source.fingerprint,
      source.status,
    ]),
  }));
}

function normalizedFact(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function preferSource(left: SourceMemory, right: SourceMemory): SourceMemory {
  if (left.status !== right.status) return left.status === "active" ? left : right;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  const leftValidated = left.lastValidatedAt ?? 0;
  const rightValidated = right.lastValidatedAt ?? 0;
  if (leftValidated !== rightValidated) return leftValidated > rightValidated ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function deduplicateSources(sources: SourceMemory[]): SourceMemory[] {
  const unique = new Map<string, SourceMemory>();
  for (const source of sources) {
    const key = `${source.type}\u0000${normalizedFact(source.content)}`;
    const previous = unique.get(key);
    unique.set(key, previous ? preferSource(previous, source) : source);
  }
  return [...unique.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function renderNarrative(modulePath: string, sources: SourceMemory[], maxChars: number): string {
  const groups: Array<[string, MemoryType[]]> = [
    ["Responsibilities and boundaries", ["architecture", "convention", "requirement", "location", "dependency"]],
    ["Technical decisions", ["decision"]],
    ["Failures and verification", ["failure", "solution", "command"]],
    ["Current risks", ["risk"]],
  ];
  const files = [...new Set(sources.flatMap((source) => source.files.filter(
    (file) => source.modules.length === 1 || moduleFromFile(file) === modulePath,
  )))].sort();
  const blocks = [`# Module: ${modulePath}`, "", "## Key files", ...(files.length ? files.map((file) => `- ${file}`) : ["- No linked files."])];
  for (const [heading, types] of groups) {
    const matching = sources.filter((source) => types.includes(source.type)).sort((left, right) =>
      types.indexOf(left.type) - types.indexOf(right.type)
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id));
    if (!matching.length) continue;
    blocks.push("", `## ${heading}`);
    for (const source of matching) {
      const freshness = source.carriedStale ? " [stale: verify against current files]" : "";
      blocks.push(`- [${source.type}]${freshness} ${source.title}: ${clip(source.content)} (${source.id})`);
    }
  }
  const included: string[] = [];
  for (const line of blocks) {
    const candidate = [...included, line].join("\n");
    if (candidate.length > maxChars) {
      const marker = "[additional content omitted]";
      if ([...included, marker].join("\n").length <= maxChars) included.push(marker);
      break;
    }
    included.push(line);
  }
  return included.join("\n");
}

export class ModuleNarrativeStore {
  constructor(private readonly context: RepositoryContext) {}

  rebuild(input: RebuildModuleNarrativesInput = {}): RebuildModuleNarrativesResult {
    const maxChars = input.maxChars ?? DEFAULT_BUDGET;
    if (!Number.isInteger(maxChars) || maxChars < MIN_BUDGET || maxChars > MAX_BUDGET) {
      throw new RepoMindError("INVALID_INPUT", `maxChars must be an integer from ${MIN_BUDGET} to ${MAX_BUDGET}`);
    }
    const requested = input.modules ? [...new Set(input.modules.map(normalizeModule))] : null;
    if (requested && !requested.length) throw new RepoMindError("INVALID_INPUT", "modules must not be empty");

    const byModule = this.sourcesByModule();
    const existingRows = this.rows();
    const existing = new Map(existingRows.map((row) => [row.module_path, row]));
    const targets = requested ?? [...new Set([...byModule.keys(), ...existing.keys()])].sort();
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;
    const touched: string[] = [];
    const db = this.context.database.raw;

    this.context.database.transaction(() => {
      for (const modulePath of targets) {
        const sources = byModule.get(modulePath) ?? [];
        const previous = existing.get(modulePath);
        if (!sources.length) {
          if (previous) {
            db.prepare("DELETE FROM module_narratives WHERE id=?").run(previous.id);
            db.prepare("DELETE FROM module_narrative_fts WHERE narrative_id=?").run(previous.id);
            deleted++;
          }
          continue;
        }
        const fingerprint = sourceFingerprint(sources);
        if (previous?.source_fingerprint === fingerprint && previous.budget_chars === maxChars) {
          unchanged++;
          touched.push(previous.id);
          continue;
        }
        const id = previous?.id ?? `l2_${randomUUID()}`;
        const now = Date.now();
        const title = `Module narrative: ${modulePath}`;
        const content = renderNarrative(modulePath, sources, maxChars);
        if (previous) {
          db.prepare(`
            UPDATE module_narratives SET title=?, content=?, source_fingerprint=?, source_count=?,
              budget_chars=?, version=version+1, updated_at=? WHERE id=?
          `).run(title, content, fingerprint, sources.length, maxChars, now, id);
          updated++;
        } else {
          db.prepare(`
            INSERT INTO module_narratives(id, repository_id, module_path, title, content, source_fingerprint,
              source_count, budget_chars, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `).run(id, this.context.marker.projectId, modulePath, title, content, fingerprint, sources.length, maxChars, now, now);
          created++;
        }
        db.prepare("DELETE FROM module_narrative_sources WHERE narrative_id=?").run(id);
        sources.forEach((source, index) => db.prepare(
          "INSERT INTO module_narrative_sources(narrative_id, memory_id, sort_order) VALUES (?, ?, ?)",
        ).run(id, source.id, index));
        db.prepare("DELETE FROM module_narrative_fts WHERE narrative_id=?").run(id);
        db.prepare("INSERT INTO module_narrative_fts(narrative_id, repository_id, module_path, title, content) VALUES (?, ?, ?, ?, ?)")
          .run(id, this.context.marker.projectId, modulePath, title, content);
        touched.push(id);
      }
    });
    return { created, updated, unchanged, deleted, narratives: this.summariesByIds(touched) };
  }

  list(): ModuleNarrativeSummary[] {
    const current = this.currentFingerprints();
    return this.rows().map((row) => this.summary(row, current.get(row.module_path) === row.source_fingerprint));
  }

  search(query: string, limit = 2): ModuleNarrativeSummary[] {
    if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 20) return [];
    const expression = buildMatchExpression(query);
    if (!expression) return [];
    const candidates = this.context.database.raw.prepare(`
      SELECT n.* FROM module_narrative_fts f
      JOIN module_narratives n ON n.id=f.narrative_id
      WHERE f.repository_id=? AND module_narrative_fts MATCH ?
      ORDER BY bm25(module_narrative_fts), n.updated_at DESC, n.id LIMIT ? OFFSET ?
    `);
    const current = this.currentFingerprints();
    const results: ModuleNarrativeSummary[] = [];
    const batchSize = Math.max(20, limit);
    for (let offset = 0; ; offset += batchSize) {
      const rows = candidates.all(this.context.marker.projectId, expression, batchSize, offset) as unknown as NarrativeRow[];
      for (const row of rows) {
        if (current.get(row.module_path) !== row.source_fingerprint) continue;
        results.push(this.summary(row, true));
        if (results.length === limit) return results;
      }
      if (rows.length < batchSize) return results;
    }
  }

  inspect(id: string): ModuleNarrativeDetails {
    const row = this.context.database.raw.prepare("SELECT * FROM module_narratives WHERE id=? AND repository_id=?")
      .get(id, this.context.marker.projectId) as NarrativeRow | undefined;
    if (!row) throw new RepoMindError("MEMORY_NOT_FOUND", `Module narrative ${id} was not found`);
    const sources = this.context.database.raw.prepare(`
      SELECT m.id, m.type, m.title, m.confidence, m.last_validated_at
      FROM module_narrative_sources ns JOIN memories m ON m.id=ns.memory_id
      WHERE ns.narrative_id=? ORDER BY ns.sort_order
    `).all(id) as Array<{ id: string; type: MemoryType; title: string; confidence: number; last_validated_at: number | null }>;
    const details: ModuleNarrativeSource[] = sources.map((source) => ({
      memoryId: source.id,
      type: source.type,
      title: source.title,
      confidence: Number(source.confidence),
      lastValidatedAt: source.last_validated_at === null ? null : Number(source.last_validated_at),
      files: (this.context.database.raw.prepare("SELECT file_path FROM memory_files WHERE memory_id=? ORDER BY file_path")
        .all(source.id) as Array<{ file_path: string }>).map((item) => item.file_path),
      evidenceIds: (this.context.database.raw.prepare("SELECT evidence_id FROM memory_evidence WHERE memory_id=? ORDER BY evidence_id")
        .all(source.id) as Array<{ evidence_id: string }>).map((item) => item.evidence_id),
    }));
    const current = this.currentFingerprints().get(row.module_path) === row.source_fingerprint;
    return { ...this.summary(row, current), sources: details };
  }

  reindex(): number {
    const rows = this.rows();
    const db = this.context.database.raw;
    this.context.database.transaction(() => {
      db.prepare("DELETE FROM module_narrative_fts WHERE repository_id=?").run(this.context.marker.projectId);
      for (const row of rows) {
        db.prepare("INSERT INTO module_narrative_fts(narrative_id, repository_id, module_path, title, content) VALUES (?, ?, ?, ?, ?)")
          .run(row.id, this.context.marker.projectId, row.module_path, row.title, row.content);
      }
    });
    return rows.length;
  }

  private sourceRows(): SourceMemory[] {
    const rows = this.context.database.raw.prepare(`
      SELECT m.id, m.type, m.title, m.content, m.confidence, m.fingerprint, m.scope_type, m.scope_value,
        m.status, m.status_reason_json, m.updated_at, m.last_validated_at, mf.file_path,
        (SELECT count(*) FROM memory_evidence me WHERE me.memory_id=m.id) AS evidence_count
      FROM memories m LEFT JOIN memory_files mf ON mf.memory_id=m.id
      WHERE m.repository_id=? AND m.status IN ('active','uncertain')
      ORDER BY m.id, mf.file_path
    `).all(this.context.marker.projectId) as Array<{
      id: string; type: MemoryType; title: string; content: string; confidence: number; fingerprint: string;
      scope_type: string; scope_value: string | null; status: "active" | "uncertain";
      status_reason_json: string | null; updated_at: number; last_validated_at: number | null;
      file_path: string | null; evidence_count: number;
    }>;
    const grouped = new Map<string, SourceMemory>();
    for (const row of rows) {
      if (Number(row.evidence_count) < 1) continue;
      let source = grouped.get(row.id);
      if (!source) {
        source = {
          id: row.id, type: row.type, title: row.title, content: row.content, confidence: Number(row.confidence),
          status: row.status,
          carriedStale: row.status === "uncertain" && this.isStaleFileReason(row.status_reason_json),
          fingerprint: row.fingerprint, updatedAt: Number(row.updated_at),
          lastValidatedAt: row.last_validated_at === null ? null : Number(row.last_validated_at),
          evidenceCount: Number(row.evidence_count), files: [], modules: [],
        };
        if (row.scope_type === "module" && row.scope_value) source.modules.push(normalizeModule(row.scope_value));
        grouped.set(row.id, source);
      }
      if (row.file_path) source.files.push(row.file_path);
    }
    for (const source of grouped.values()) {
      if (!source.modules.length) source.modules = [...new Set(source.files.map(moduleFromFile))];
    }
    return [...grouped.values()].filter((source) =>
      source.modules.length && (source.status === "active" || source.carriedStale)).sort((a, b) =>
      a.type.localeCompare(b.type) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  private sourcesByModule(): Map<string, SourceMemory[]> {
    const previous = this.previousSourceIdsByModule();
    const result = new Map<string, SourceMemory[]>();
    for (const source of this.sourceRows()) {
      for (const modulePath of source.modules) {
        if (source.carriedStale && !previous.get(modulePath)?.has(source.id)) continue;
        result.set(modulePath, [...(result.get(modulePath) ?? []), source]);
      }
    }
    for (const [modulePath, sources] of result) result.set(modulePath, deduplicateSources(sources));
    return result;
  }

  private previousSourceIdsByModule(): Map<string, Set<string>> {
    const rows = this.context.database.raw.prepare(`
      SELECT n.module_path, ns.memory_id
      FROM module_narratives n JOIN module_narrative_sources ns ON ns.narrative_id=n.id
      WHERE n.repository_id=? ORDER BY n.module_path, ns.sort_order
    `).all(this.context.marker.projectId) as Array<{ module_path: string; memory_id: string }>;
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      const ids = result.get(row.module_path) ?? new Set<string>();
      ids.add(row.memory_id);
      result.set(row.module_path, ids);
    }
    return result;
  }

  private isStaleFileReason(value: string | null): boolean {
    if (!value) return false;
    try {
      return (JSON.parse(value) as { kind?: unknown }).kind === "stale_files";
    } catch {
      return false;
    }
  }

  private currentFingerprints(): Map<string, string> {
    return new Map([...this.sourcesByModule()].map(([modulePath, sources]) => [modulePath, sourceFingerprint(sources)]));
  }

  private rows(): NarrativeRow[] {
    return this.context.database.raw.prepare(
      "SELECT * FROM module_narratives WHERE repository_id=? ORDER BY module_path",
    ).all(this.context.marker.projectId) as unknown as NarrativeRow[];
  }

  private summariesByIds(ids: string[]): ModuleNarrativeSummary[] {
    const selected = new Set(ids);
    return this.list().filter((item) => selected.has(item.id));
  }

  private summary(row: NarrativeRow, current: boolean): ModuleNarrativeSummary {
    const sourceMemoryIds = (this.context.database.raw.prepare(
      "SELECT memory_id FROM module_narrative_sources WHERE narrative_id=? ORDER BY sort_order",
    ).all(row.id) as Array<{ memory_id: string }>).map((source) => source.memory_id);
    return {
      id: row.id,
      modulePath: row.module_path,
      title: row.title,
      content: row.content,
      sourceCount: Number(row.source_count),
      sourceMemoryIds,
      budgetChars: Number(row.budget_chars),
      version: Number(row.version),
      current,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
