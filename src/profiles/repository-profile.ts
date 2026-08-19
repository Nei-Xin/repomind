import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  MemoryType,
  RebuildRepositoryProfileInput,
  RebuildRepositoryProfileResult,
  RepositoryProfileDetails,
  RepositoryProfileMemorySource,
  RepositoryProfileModuleSource,
  RepositoryProfileSummary,
  RepositoryProfileVersion,
} from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import type { RepositoryContext } from "../repository.js";

interface StableMemory {
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
}

interface StableModule {
  id: string;
  modulePath: string;
  memories: StableMemory[];
}

interface ProfileRow {
  id: string;
  title: string;
  content: string;
  source_fingerprint: string;
  memory_source_count: number;
  module_source_count: number;
  budget_chars: number;
  min_confidence: number;
  version: number;
  created_at: number;
  updated_at: number;
}

const DEFAULT_BUDGET = 6_000;
const MIN_BUDGET = 1_000;
const MAX_BUDGET = 30_000;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const PROFILE_RENDER_VERSION = 3;
const STABLE_TYPES: ReadonlySet<MemoryType> = new Set([
  "architecture", "convention", "decision", "command", "dependency", "requirement", "risk",
]);
const PROFILE_MODULE_TYPES: ReadonlySet<MemoryType> = new Set([
  "architecture", "convention", "decision", "dependency", "requirement", "risk",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clip(value: string, max = 320): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function normalizedFact(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function preferMemory(left: StableMemory, right: StableMemory): StableMemory {
  if (left.status !== right.status) return left.status === "active" ? left : right;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  const leftValidated = left.lastValidatedAt ?? 0;
  const rightValidated = right.lastValidatedAt ?? 0;
  if (leftValidated !== rightValidated) return leftValidated > rightValidated ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function deduplicateMemories(memories: StableMemory[]): StableMemory[] {
  const unique = new Map<string, StableMemory>();
  for (const memory of memories) {
    const key = `${memory.type}\u0000${normalizedFact(memory.content)}`;
    const previous = unique.get(key);
    unique.set(key, previous ? preferMemory(previous, memory) : memory);
  }
  return [...unique.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function isStaleFileReason(value: string | null): boolean {
  if (!value) return false;
  try {
    return (JSON.parse(value) as { kind?: unknown }).kind === "stale_files";
  } catch {
    return false;
  }
}

function moduleFromFile(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const directory = posix.dirname(normalized).replace(/^\/+|\/+$/gu, "");
  return directory && directory !== "." ? directory : ".";
}

function appendBounded(lines: string[], maxChars: number): string {
  const included: string[] = [];
  for (const line of lines) {
    if ([...included, line].join("\n").length > maxChars) {
      const marker = "[additional content omitted]";
      if ([...included, marker].join("\n").length <= maxChars) included.push(marker);
      break;
    }
    included.push(line);
  }
  return included.join("\n");
}

function moduleStatement(module: StableModule): string {
  const selected = module.memories.slice(0, 2);
  return selected.map((memory) => {
    const freshness = memory.carriedStale ? " [stale: verify against current files]" : "";
    return `[${memory.type}]${freshness} ${memory.title}: ${clip(memory.content, 180)}`;
  }).join("; ");
}

function fingerprint(memories: StableMemory[], modules: StableModule[], budget: number, minConfidence: number): string {
  return sha256(JSON.stringify({
    renderVersion: PROFILE_RENDER_VERSION,
    budget,
    minConfidence,
    memories: memories.map((item) => [item.id, item.fingerprint, item.status]),
    modules: modules.map((item) => [item.id, item.modulePath, item.memories.map((memory) => [
      memory.id, memory.fingerprint, memory.status,
    ])]),
  }));
}

function renderProfile(repositoryName: string, memories: StableMemory[], modules: StableModule[], maxChars: number): string {
  const lines = [`# Repository Profile: ${repositoryName}`];
  const moduleLines = modules.flatMap((module) => {
    const statement = moduleStatement(module);
    return statement ? [`- ${module.modulePath}: ${clip(statement)} (${module.id})`] : [];
  });
  if (moduleLines.length) {
    lines.push("", "## Modules and responsibilities");
    lines.push(...moduleLines);
  }
  const groups: Array<[string, MemoryType[]]> = [
    ["Technology and environment", ["dependency", "architecture"]],
    ["Build, test, and checks", ["command", "convention"]],
    ["Core decisions and constraints", ["decision", "requirement"]],
    ["Long-term risks", ["risk"]],
  ];
  for (const [heading, types] of groups) {
    const matching = memories.filter((memory) => types.includes(memory.type));
    if (!matching.length) continue;
    lines.push("", `## ${heading}`);
    for (const memory of matching) {
      const freshness = memory.carriedStale ? " [stale: verify against current files]" : "";
      lines.push(`- [${memory.type}]${freshness} ${memory.title}: ${clip(memory.content)} (${memory.id})`);
    }
  }
  return appendBounded(lines, maxChars);
}

export class RepositoryProfileStore {
  constructor(private readonly context: RepositoryContext) {}

  rebuild(input: RebuildRepositoryProfileInput = {}): RebuildRepositoryProfileResult {
    const maxChars = input.maxChars ?? DEFAULT_BUDGET;
    const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    if (!Number.isInteger(maxChars) || maxChars < MIN_BUDGET || maxChars > MAX_BUDGET) {
      throw new RepoMindError("INVALID_INPUT", `maxChars must be an integer from ${MIN_BUDGET} to ${MAX_BUDGET}`);
    }
    if (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1) {
      throw new RepoMindError("INVALID_INPUT", "minConfidence must be from 0.5 to 1");
    }
    const memories = this.stableMemories(minConfidence);
    const modules = this.stableModules(minConfidence);
    if (!memories.length && !modules.length) {
      throw new RepoMindError("INVALID_INPUT", "No stable L1 or current L2 sources are available for a repository profile");
    }
    const sourceFingerprint = fingerprint(memories, modules, maxChars, minConfidence);
    const previous = this.row();
    if (previous?.source_fingerprint === sourceFingerprint) {
      return { created: false, updated: false, unchanged: true, profile: this.summary(previous, true) };
    }

    const id = previous?.id ?? `l3_${randomUUID()}`;
    const now = Date.now();
    const version = previous ? previous.version + 1 : 1;
    const title = `Repository profile: ${this.context.marker.name}`;
    const content = renderProfile(this.context.marker.name, memories, modules, maxChars);
    const memoryIds = [...new Set([
      ...memories.map((item) => item.id),
      ...modules.flatMap((item) => item.memories.map((memory) => memory.id)),
    ])];
    const narrativeIds = modules.map((item) => item.id);
    const db = this.context.database.raw;
    this.context.database.transaction(() => {
      if (previous) {
        db.prepare(`
          UPDATE repository_profiles SET title=?, content=?, source_fingerprint=?, memory_source_count=?,
            module_source_count=?, budget_chars=?, min_confidence=?, version=?, updated_at=? WHERE id=?
        `).run(title, content, sourceFingerprint, memories.length, modules.length, maxChars, minConfidence, version, now, id);
      } else {
        db.prepare(`
          INSERT INTO repository_profiles(id, repository_id, title, content, source_fingerprint,
            memory_source_count, module_source_count, budget_chars, min_confidence, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(id, this.context.marker.projectId, title, content, sourceFingerprint, memories.length, modules.length, maxChars, minConfidence, now, now);
      }
      db.prepare("DELETE FROM repository_profile_memory_sources WHERE profile_id=?").run(id);
      db.prepare("DELETE FROM repository_profile_module_sources WHERE profile_id=?").run(id);
      memories.forEach((memory, index) => db.prepare(
        "INSERT INTO repository_profile_memory_sources(profile_id, memory_id, sort_order) VALUES (?, ?, ?)",
      ).run(id, memory.id, index));
      modules.forEach((module, index) => db.prepare(
        "INSERT INTO repository_profile_module_sources(profile_id, narrative_id, sort_order) VALUES (?, ?, ?)",
      ).run(id, module.id, index));
      db.prepare(`
        INSERT INTO repository_profile_versions(profile_id, version, content, source_fingerprint,
          memory_ids_json, narrative_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, version, content, sourceFingerprint, JSON.stringify(memoryIds), JSON.stringify(narrativeIds), now);
    });
    return { created: !previous, updated: Boolean(previous), unchanged: false, profile: this.summary(this.row()!, true) };
  }

  get(): RepositoryProfileSummary | null {
    const row = this.row();
    return row ? this.summary(row, row.source_fingerprint === this.currentFingerprint(row)) : null;
  }

  inspect(): RepositoryProfileDetails {
    const row = this.row();
    if (!row) throw new RepoMindError("MEMORY_NOT_FOUND", "Repository profile was not found");
    const db = this.context.database.raw;
    const memoryRows = db.prepare(`
      SELECT m.id, m.type, m.title, m.confidence FROM repository_profile_memory_sources ps
      JOIN memories m ON m.id=ps.memory_id WHERE ps.profile_id=? ORDER BY ps.sort_order
    `).all(row.id) as Array<{ id: string; type: MemoryType; title: string; confidence: number }>;
    const memorySources: RepositoryProfileMemorySource[] = memoryRows.map((memory) => ({
      memoryId: memory.id,
      type: memory.type,
      title: memory.title,
      confidence: Number(memory.confidence),
      evidenceIds: (db.prepare("SELECT evidence_id FROM memory_evidence WHERE memory_id=? ORDER BY evidence_id")
        .all(memory.id) as Array<{ evidence_id: string }>).map((item) => item.evidence_id),
    }));
    const moduleRows = db.prepare(`
      SELECT n.id, n.module_path, n.version FROM repository_profile_module_sources ps
      JOIN module_narratives n ON n.id=ps.narrative_id WHERE ps.profile_id=? ORDER BY ps.sort_order
    `).all(row.id) as Array<{ id: string; module_path: string; version: number }>;
    const currentModules = new Map(this.stableModules(row.min_confidence).map((module) => [module.id, module]));
    const moduleSources: RepositoryProfileModuleSource[] = moduleRows.map((module) => ({
      narrativeId: module.id,
      modulePath: module.module_path,
      version: Number(module.version),
      memoryIds: currentModules.get(module.id)?.memories.map((memory) => memory.id) ?? [],
    }));
    const versions = db.prepare(`
      SELECT version, content, source_fingerprint, memory_ids_json, narrative_ids_json, created_at
      FROM repository_profile_versions WHERE profile_id=? ORDER BY version
    `).all(row.id) as Array<{
      version: number; content: string; source_fingerprint: string; memory_ids_json: string;
      narrative_ids_json: string; created_at: number;
    }>;
    const history: RepositoryProfileVersion[] = versions.map((version) => ({
      version: Number(version.version),
      content: version.content,
      sourceFingerprint: version.source_fingerprint,
      memoryIds: JSON.parse(version.memory_ids_json) as string[],
      narrativeIds: JSON.parse(version.narrative_ids_json) as string[],
      createdAt: Number(version.created_at),
    }));
    return {
      ...this.summary(row, row.source_fingerprint === this.currentFingerprint(row)),
      memorySources,
      moduleSources,
      versions: history,
    };
  }

  private stableMemories(minConfidence: number): StableMemory[] {
    const previous = this.previousMemorySourceIds();
    const rows = this.context.database.raw.prepare(`
      SELECT m.id, m.type, m.title, m.content, m.status, m.status_reason_json, m.confidence,
        m.fingerprint, m.updated_at, m.last_validated_at,
        (SELECT count(*) FROM memory_evidence me WHERE me.memory_id=m.id) AS evidence_count
      FROM memories m
      WHERE m.repository_id=? AND m.status IN ('active','uncertain')
        AND m.scope_type='repository' AND m.confidence>=?
      ORDER BY m.type, m.title, m.id
    `).all(this.context.marker.projectId, minConfidence) as Array<{
      id: string; type: MemoryType; title: string; content: string; confidence: number;
      status: "active" | "uncertain"; status_reason_json: string | null; fingerprint: string;
      updated_at: number; last_validated_at: number | null; evidence_count: number;
    }>;
    return deduplicateMemories(rows
      .filter((row) => STABLE_TYPES.has(row.type) && Number(row.evidence_count) > 0)
      .map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        status: row.status,
        carriedStale: row.status === "uncertain" && isStaleFileReason(row.status_reason_json),
        confidence: Number(row.confidence),
        fingerprint: row.fingerprint,
        updatedAt: Number(row.updated_at),
        lastValidatedAt: row.last_validated_at === null ? null : Number(row.last_validated_at),
        evidenceCount: Number(row.evidence_count),
      }))
      .filter((memory) => memory.status === "active" || (memory.carriedStale && previous.has(memory.id))));
  }

  private stableModules(minConfidence: number): StableModule[] {
    const modules = this.context.database.raw.prepare(
      "SELECT id, module_path FROM module_narratives WHERE repository_id=? ORDER BY module_path",
    ).all(this.context.marker.projectId) as Array<{ id: string; module_path: string }>;
    const knownModules = new Map(modules.map((module) => [module.module_path, module.id]));
    const previous = this.previousModuleSourceIds();
    const rows = this.context.database.raw.prepare(`
      SELECT m.id, m.type, m.title, m.content, m.status, m.status_reason_json, m.confidence,
        m.fingerprint, m.updated_at, m.last_validated_at, m.scope_type, m.scope_value, mf.file_path,
        (SELECT count(*) FROM memory_evidence me WHERE me.memory_id=m.id) AS evidence_count
      FROM memories m LEFT JOIN memory_files mf ON mf.memory_id=m.id
      WHERE m.repository_id=? AND m.status IN ('active','uncertain') AND m.confidence>=?
      ORDER BY m.type, m.title, m.id, mf.file_path
    `).all(this.context.marker.projectId, minConfidence) as Array<{
      id: string; type: MemoryType; title: string; content: string; confidence: number;
      status: "active" | "uncertain"; status_reason_json: string | null; fingerprint: string;
      updated_at: number; last_validated_at: number | null; evidence_count: number; scope_type: string;
      scope_value: string | null; file_path: string | null;
    }>;
    const grouped = new Map<string, { memory: StableMemory; modules: Set<string> }>();
    for (const row of rows) {
      if (Number(row.evidence_count) < 1 || !PROFILE_MODULE_TYPES.has(row.type)) continue;
      let source = grouped.get(row.id);
      if (!source) {
        source = {
          memory: {
            id: row.id, type: row.type, title: row.title, content: row.content,
            status: row.status,
            carriedStale: row.status === "uncertain" && isStaleFileReason(row.status_reason_json),
            confidence: Number(row.confidence), fingerprint: row.fingerprint,
            updatedAt: Number(row.updated_at),
            lastValidatedAt: row.last_validated_at === null ? null : Number(row.last_validated_at),
            evidenceCount: Number(row.evidence_count),
          },
          modules: new Set<string>(),
        };
        grouped.set(row.id, source);
      }
      if (row.scope_type === "module" && row.scope_value) source.modules.add(row.scope_value.replaceAll("\\", "/"));
      else if (row.file_path) source.modules.add(moduleFromFile(row.file_path));
    }
    const byModule = new Map<string, StableMemory[]>();
    for (const source of grouped.values()) {
      for (const modulePath of source.modules) {
        if (!knownModules.has(modulePath)) continue;
        if (source.memory.status !== "active"
          && !(source.memory.carriedStale && previous.get(modulePath)?.has(source.memory.id))) continue;
        byModule.set(modulePath, [...(byModule.get(modulePath) ?? []), source.memory]);
      }
    }
    return modules.flatMap((module) => {
      const memories = deduplicateMemories(byModule.get(module.module_path) ?? []);
      return memories.length ? [{ id: module.id, modulePath: module.module_path, memories }] : [];
    });
  }

  private previousMemorySourceIds(): Set<string> {
    const rows = this.context.database.raw.prepare(`
      SELECT ps.memory_id FROM repository_profile_memory_sources ps
      JOIN repository_profiles p ON p.id=ps.profile_id WHERE p.repository_id=?
      ORDER BY ps.sort_order
    `).all(this.context.marker.projectId) as Array<{ memory_id: string }>;
    return new Set(rows.map((row) => row.memory_id));
  }

  private previousModuleSourceIds(): Map<string, Set<string>> {
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

  private currentFingerprint(row: ProfileRow): string {
    return fingerprint(this.stableMemories(row.min_confidence), this.stableModules(row.min_confidence), row.budget_chars, row.min_confidence);
  }

  private row(): ProfileRow | null {
    return (this.context.database.raw.prepare("SELECT * FROM repository_profiles WHERE repository_id=?")
      .get(this.context.marker.projectId) as ProfileRow | undefined) ?? null;
  }

  private summary(row: ProfileRow, current: boolean): RepositoryProfileSummary {
    const version = this.context.database.raw.prepare(`
      SELECT memory_ids_json, narrative_ids_json FROM repository_profile_versions
      WHERE profile_id=? AND version=?
    `).get(row.id, row.version) as { memory_ids_json: string; narrative_ids_json: string } | undefined;
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      memorySourceCount: Number(row.memory_source_count),
      moduleSourceCount: Number(row.module_source_count),
      sourceMemoryIds: version ? JSON.parse(version.memory_ids_json) as string[] : [],
      sourceModuleNarrativeIds: version ? JSON.parse(version.narrative_ids_json) as string[] : [],
      budgetChars: Number(row.budget_chars),
      minConfidence: Number(row.min_confidence),
      version: Number(row.version),
      current,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
