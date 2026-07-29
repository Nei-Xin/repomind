import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import {
  backupManifestPath,
  backupRepository,
  exportRepository,
  importRepository,
  loadRepositoryExport,
  restoreRepository,
} from "../src/portability/repository-data.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rewriteChecksum(bundle: Record<string, unknown>): void {
  const { checksum: _checksum, ...payload } = bundle;
  bundle.checksum = createHash("sha256").update(stableJson(payload)).digest("hex");
}

describe("repository export, import, backup, and restore", () => {
  let sourceRepository: string;
  let targetRepository: string;
  let data: string;
  let artifacts: string;

  beforeEach(() => {
    sourceRepository = createTestRepository("repomind-portable-source-");
    targetRepository = createTestRepository("repomind-portable-target-");
    data = mkdtempSync(join(tmpdir(), "repomind-portable-data-"));
    artifacts = mkdtempSync(join(tmpdir(), "repomind-portable-artifacts-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(sourceRepository).database.close();
    initializeRepository(targetRepository).database.close();
  });

  afterEach(() => {
    rmSync(sourceRepository, { recursive: true, force: true });
    rmSync(targetRepository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("exports a versioned bundle and atomically replaces a different project", () => {
    const source = new RepositoryMemoryCore(sourceRepository);
    const moduleMemory = source.record({
      type: "architecture", title: "Storage boundary", content: "SQLite transactions live in src/storage.",
      scopeType: "module", scopeValue: "src/storage", confidence: 0.95,
    });
    source.record({ type: "command", title: "Release checks", content: "Run npm test before release.", confidence: 0.95 });
    source.rebuildModuleNarratives();
    source.rebuildRepositoryProfile();
    for (let index = 1; index <= 3; index++) {
      const started = source.startSession({ task: `Run release v0.${index}.0` });
      source.commitSession({
        sessionId: started.sessionId,
        idempotencyKey: `portable-release-${index}`,
        status: "success",
        summary: `Release v0.${index}.0 completed.`,
        commands: [{ command: "npm run build", exitCode: 0, summary: "Build passed." }],
        tests: [{ command: "npm test", exitCode: 0, summary: "Tests passed." }],
      });
    }
    const skill = source.rebuildSkillCandidates().candidates[0]!;
    source.reviewSkillCandidate({ candidateId: skill.id, action: "approve", reason: "Portable workflow reviewed." });
    const sourceProjectId = source.context.marker.projectId;
    const exportPath = join(artifacts, "repository-export.json");
    const exported = exportRepository(source.context, exportPath);
    expect(exported.counts.memories).toBeGreaterThan(2);
    expect(exported.counts.module_narratives).toBe(1);
    expect(exported.counts.repository_profiles).toBe(1);
    expect(exported.counts.skill_candidates).toBe(1);
    expect(exported.counts.skill_candidate_sessions).toBe(3);
    const legacyPath = join(artifacts, "repository-export-v1.json");
    const legacy = JSON.parse(readFileSync(exportPath, "utf8")) as Record<string, unknown>;
    legacy.formatVersion = 1;
    const legacyTables = legacy.tables as Record<string, unknown>;
    for (const name of Object.keys(legacyTables).filter((name) => name.startsWith("skill_candidate"))) delete legacyTables[name];
    rewriteChecksum(legacy);
    writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    expect(loadRepositoryExport(legacyPath).tables.skill_candidates).toEqual([]);
    source.close();

    const target = new RepositoryMemoryCore(targetRepository);
    const targetProjectId = target.context.marker.projectId;
    const old = target.record({ type: "decision", title: "Temporary target fact", content: "This must be replaced." });
    const preview = importRepository(target.context, exportPath, { dryRun: true });
    expect(preview).toMatchObject({ imported: false, sourceProjectId, targetProjectId });
    expect(target.inspect(old.id).title).toBe("Temporary target fact");

    const imported = importRepository(target.context, exportPath);
    expect(imported).toMatchObject({ imported: true, sourceProjectId, targetProjectId });
    expect(() => target.inspect(old.id)).toThrow();
    expect(target.search("SQLite transactions").map((item) => item.id)).toContain(moduleMemory.id);
    expect(target.inspectSkillCandidate(skill.id)).toMatchObject({ status: "approved", sourceSessionCount: 3 });
    expect(target.status()).toMatchObject({
      memories: exported.counts.memories,
      moduleNarratives: 1,
      repositoryProfiles: 1,
      skillCandidates: 1,
      embeddings: 0,
    });
    expect(target.context.marker.projectId).toBe(targetProjectId);
    expect(target.inspectRepositoryProfile().versions).toHaveLength(1);
    target.close();
  });

  it("rejects tampering and rolls back a relational failure without losing target data", () => {
    const source = new RepositoryMemoryCore(sourceRepository);
    source.record({ type: "convention", title: "Typed APIs", content: "Public APIs use explicit types." });
    const exportPath = join(artifacts, "valid.json");
    exportRepository(source.context, exportPath);
    source.close();

    const target = new RepositoryMemoryCore(targetRepository);
    const existing = target.record({ type: "decision", title: "Keep on failure", content: "Atomic import preserves this." });
    const tampered = JSON.parse(readFileSync(exportPath, "utf8")) as Record<string, unknown>;
    const tables = tampered.tables as Record<string, Array<Record<string, unknown>>>;
    tables.memories![0]!.title = "Changed without checksum";
    const badChecksumPath = join(artifacts, "bad-checksum.json");
    writeFileSync(badChecksumPath, JSON.stringify(tampered), "utf8");
    expect(() => importRepository(target.context, badChecksumPath)).toThrow(/checksum/u);
    expect(target.inspect(existing.id).title).toBe("Keep on failure");

    const brokenRelation = JSON.parse(readFileSync(exportPath, "utf8")) as Record<string, unknown>;
    const brokenTables = brokenRelation.tables as Record<string, Array<Record<string, unknown>>>;
    brokenTables.memory_evidence![0]!.evidence_id = "ev_missing";
    rewriteChecksum(brokenRelation);
    const brokenRelationPath = join(artifacts, "broken-relation.json");
    writeFileSync(brokenRelationPath, JSON.stringify(brokenRelation), "utf8");
    expect(() => importRepository(target.context, brokenRelationPath)).toThrow();
    expect(target.inspect(existing.id).title).toBe("Keep on failure");
    expect(target.status()).toMatchObject({ memories: 1 });
    target.close();
  });

  it("creates a checksummed physical backup and restores it with a retained rollback snapshot", () => {
    const core = new RepositoryMemoryCore(sourceRepository);
    const retained = core.record({ type: "decision", title: "Retained fact", content: "This exists in the backup." });
    const backupPath = join(artifacts, "repository.db");
    const backup = backupRepository(core.context, backupPath);
    expect(existsSync(backup.path)).toBe(true);
    expect(existsSync(backup.manifestPath)).toBe(true);
    const removed = core.record({ type: "risk", title: "Post-backup fact", content: "Restore removes this later write." });
    core.close();

    expect(restoreRepository(sourceRepository, backupPath, { dryRun: true })).toMatchObject({ restored: false, preRestoreBackup: null });
    const restored = restoreRepository(sourceRepository, backupPath);
    expect(restored.restored).toBe(true);
    expect(restored.preRestoreBackup && existsSync(restored.preRestoreBackup)).toBe(true);
    expect(restored.preRestoreBackup && existsSync(backupManifestPath(restored.preRestoreBackup))).toBe(true);
    const reopened = new RepositoryMemoryCore(sourceRepository);
    expect(reopened.inspect(retained.id).title).toBe("Retained fact");
    expect(() => reopened.inspect(removed.id)).toThrow();
    reopened.close();

    appendFileSync(backupPath, "tampered", "utf8");
    expect(() => restoreRepository(sourceRepository, backupPath)).toThrow(/checksum/u);
    const afterRejectedRestore = new RepositoryMemoryCore(sourceRepository);
    expect(afterRejectedRestore.inspect(retained.id).title).toBe("Retained fact");
    afterRejectedRestore.close();
  });

  it("requires explicit approval to replace an unreadable live database", () => {
    const core = new RepositoryMemoryCore(sourceRepository);
    const retained = core.record({ type: "decision", title: "Recoverable fact", content: "This remains in the backup." });
    const backupPath = join(artifacts, "recovery.db");
    backupRepository(core.context, backupPath);
    const livePath = core.context.database.path;
    core.close();
    writeFileSync(livePath, "not a sqlite database", "utf8");

    expect(() => restoreRepository(sourceRepository, backupPath)).toThrow(/allow-unreadable/u);
    const restored = restoreRepository(sourceRepository, backupPath, { allowUnreadable: true });
    expect(restored).toMatchObject({ restored: true, previousDatabase: "unreadable" });
    expect(restored.preRestoreBackup && existsSync(restored.preRestoreBackup)).toBe(true);
    const reopened = new RepositoryMemoryCore(sourceRepository);
    expect(reopened.inspect(retained.id).title).toBe("Recoverable fact");
    reopened.close();
  });

  it("blocks a logical export when stored data matches a sensitive pattern", () => {
    const core = new RepositoryMemoryCore(sourceRepository);
    const memory = core.record({ type: "decision", title: "Credential rotation", content: "Credential was already redacted." });
    core.context.database.raw.prepare("UPDATE memories SET content=? WHERE id=?")
      .run(`Accidental token sk-${"a".repeat(24)}`, memory.id);
    expect(() => exportRepository(core.context, join(artifacts, "blocked.json"))).toThrow(/sensitive/u);
    const allowed = exportRepository(core.context, join(artifacts, "confirmed.json"), { allowSensitive: true });
    expect(allowed.sensitiveFindings).toBeGreaterThan(0);
    core.close();
  });

  it("refuses export and backup while repository work is active", () => {
    const core = new RepositoryMemoryCore(sourceRepository);
    const session = core.startSession({ task: "Keep this session open" });
    expect(() => exportRepository(core.context, join(artifacts, "active.json"))).toThrow(/open sessions/u);
    expect(() => backupRepository(core.context, join(artifacts, "active.db"))).toThrow(/open sessions/u);
    core.abandonSession(session.sessionId);
    expect(exportRepository(core.context, join(artifacts, "settled.json")).counts.sessions).toBe(1);
    core.close();
  });
});
