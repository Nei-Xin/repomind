import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations.js";

interface ReleasedSchemaManifest {
  schemaVersion: number;
  releases: Record<string, number>;
  migrationSha256: Record<string, string>;
}

const releasedSchemas = JSON.parse(readFileSync(
  resolve("tests/fixtures/released-schema-manifest.json"),
  "utf8",
)) as ReleasedSchemaManifest;

function legacyDatabase(path: string, throughVersion: number): DatabaseSync {
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const migration of migrations.filter((item) => item.version <= throughVersion)) {
    legacy.exec(migration.sql);
    legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
  }
  return legacy;
}

function seedReleasedDatabase(database: DatabaseSync, version: number): void {
  const now = 1_700_000_000_000;
  database.prepare("INSERT INTO repositories(id, name, created_at, updated_at) VALUES ('repo_release','released-fixture',?,?)").run(now, now);
  database.prepare("INSERT INTO repository_checkouts(id, repository_id, root_path, last_seen_at) VALUES ('checkout_release','repo_release','/released/fixture',?)").run(now);
  database.prepare(`
    INSERT INTO sessions(id, repository_id, checkout_id, task, status, baseline_dirty, final_dirty, started_at, ended_at)
    VALUES ('ses_release','repo_release','checkout_release','Preserve released data','committed',0,0,?,?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO evidence(id, repository_id, session_id, kind, content, content_hash, metadata_json, created_at)
    VALUES ('evd_release','repo_release','ses_release','test_result','released fixture passed','hash-release','{}',?)
  `).run(now);
  database.prepare(`
    INSERT INTO memories(id, repository_id, type, title, content, confidence, status, scope_type, source,
      tags_json, fingerprint, created_at, updated_at, last_validated_at, status_reason_json)
    VALUES ('mem_release','repo_release','solution','Released memory','Preserve this memory through upgrades.',1,
      'active','repository','manual','["released-fixture"]','fp-release',?,?,?,NULL)
  `).run(now, now, now);
  database.exec(`
    INSERT INTO memory_evidence(memory_id, evidence_id) VALUES ('mem_release','evd_release');
    INSERT INTO memory_files(memory_id, file_path, file_hash, file_size, file_mtime_ms)
      VALUES ('mem_release','src/released.ts','file-hash',42,1700000000000);
    INSERT INTO memory_audit_log(id, memory_id, action, next_json, reason, created_at)
      VALUES ('aud_release','mem_release','created','{}','released fixture created',1700000000000);
    INSERT INTO memory_fts(memory_id, repository_id, title, content, search_tokens)
      VALUES ('mem_release','repo_release','Released memory','Preserve this memory through upgrades.','released memory preserve upgrades');
  `);

  if (version >= 7) {
    database.exec(`
      INSERT INTO memory_embeddings(memory_id, repository_id, model, dimensions, content_hash, embedding, updated_at)
      VALUES ('mem_release','repo_release','released-model',1,'embedding-hash',X'00000000',1700000000000);
    `);
  }
  if (version >= 8) {
    database.exec(`
      INSERT INTO host_runs(id, repository_id, session_id, task, runner, output_directory, status,
        retrieved_memories, metadata_json, started_at, ended_at)
      VALUES ('run_release','repo_release','ses_release','Preserve released data','opencode','/released/output',
        'committed',1,'{}',1700000000000,1700000000000);
    `);
  }
  if (version >= 9) {
    database.exec(`
      INSERT INTO module_narratives(id, repository_id, module_path, title, content, source_fingerprint,
        source_count, budget_chars, version, created_at, updated_at)
      VALUES ('l2_release','repo_release','src','Released module','Released module narrative.','l2-fingerprint',
        1,500,1,1700000000000,1700000000000);
      INSERT INTO module_narrative_sources(narrative_id, memory_id, sort_order)
        VALUES ('l2_release','mem_release',0);
      INSERT INTO module_narrative_fts(narrative_id, repository_id, module_path, title, content)
        VALUES ('l2_release','repo_release','src','Released module','Released module narrative.');
    `);
  }
  if (version >= 10) {
    database.exec(`
      INSERT INTO repository_profiles(id, repository_id, title, content, source_fingerprint,
        memory_source_count, module_source_count, budget_chars, min_confidence, version, created_at, updated_at)
      VALUES ('l3_release','repo_release','Released profile','Released repository profile.','l3-fingerprint',
        1,1,1000,0.8,1,1700000000000,1700000000000);
      INSERT INTO repository_profile_memory_sources(profile_id, memory_id, sort_order)
        VALUES ('l3_release','mem_release',0);
      INSERT INTO repository_profile_module_sources(profile_id, narrative_id, sort_order)
        VALUES ('l3_release','l2_release',0);
      INSERT INTO repository_profile_versions(profile_id, version, content, source_fingerprint,
        memory_ids_json, narrative_ids_json, created_at)
      VALUES ('l3_release',1,'Released repository profile.','l3-fingerprint','["mem_release"]','["l2_release"]',1700000000000);
    `);
  }
  if (version >= 11) {
    database.exec(`
      INSERT INTO skill_candidates(id, repository_id, workflow_key, title, trigger_text, inputs_json,
        steps_json, verification_json, risks_json, source_fingerprint, source_session_count, status,
        created_at, updated_at)
      VALUES ('l4_release','repo_release','released-workflow','Released workflow','When releasing.','[]',
        '["Run verification"]','["Tests pass"]','[]','l4-fingerprint',3,'approved',1700000000000,1700000000000);
      INSERT INTO skill_candidate_sessions(candidate_id, session_id, sort_order)
        VALUES ('l4_release','ses_release',0);
      INSERT INTO skill_candidate_evidence(candidate_id, evidence_id)
        VALUES ('l4_release','evd_release');
      INSERT INTO skill_candidate_audit_log(id, candidate_id, action, next_status, reason, metadata_json, created_at)
        VALUES ('aud_l4_release','l4_release','approved','approved','released fixture approved','{}',1700000000000);
    `);
  }
}

describe("database migrations", () => {
  it("locks every published migration body and release-to-schema mapping", () => {
    expect(releasedSchemas.schemaVersion).toBe(1);
    expect(Object.keys(releasedSchemas.releases)).toEqual([
      "v0.4.0", "v0.5.0", "v0.6.0", "v0.7.0", "v0.7.1", "v0.8.0", "v0.9.0",
      "v0.10.0", "v0.11.0", "v0.12.0", "v0.13.0", "v0.14.0", "v0.15.0", "v0.16.0", "v0.17.0", "v0.18.0", "v1.0.0-rc.1", "v1.0.0-rc.2",
    ]);
    expect(Object.fromEntries(migrations.map((migration) => [
      String(migration.version),
      createHash("sha256").update(migration.sql).digest("hex"),
    ]))).toEqual(releasedSchemas.migrationSha256);
  });

  it("upgrades a version 1 database through every later migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-migration-"));
    const path = join(directory, "repomind.db");
    try {
      legacyDatabase(path, 1).close();

      const upgraded = new Database(path);
      try {
        const columns = (upgraded.raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((column) => column.name);
        const fileColumns = (upgraded.raw.prepare("PRAGMA table_info(memory_files)").all() as Array<{ name: string }>).map((column) => column.name);
        const versions = upgraded.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
        const table = (name: string): unknown =>
          upgraded.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        expect(columns).toContain("status_reason_json");
        expect(fileColumns).toEqual(expect.arrayContaining(["file_size", "file_mtime_ms"]));
        expect(table("memory_relations")).toEqual({ name: "memory_relations" });
        expect(table("forget_log")).toEqual({ name: "forget_log" });
        expect(table("memory_embeddings")).toEqual({ name: "memory_embeddings" });
        expect(table("host_runs")).toEqual({ name: "host_runs" });
        expect(table("module_narratives")).toEqual({ name: "module_narratives" });
        expect(table("module_narrative_sources")).toEqual({ name: "module_narrative_sources" });
        expect(table("repository_profiles")).toEqual({ name: "repository_profiles" });
        expect(table("repository_profile_versions")).toEqual({ name: "repository_profile_versions" });
        expect(table("skill_candidates")).toEqual({ name: "skill_candidates" });
        expect(table("skill_candidate_sessions")).toEqual({ name: "skill_candidate_sessions" });
        expect(table("skill_candidate_evidence")).toEqual({ name: "skill_candidate_evidence" });
        expect(table("skill_candidate_audit_log")).toEqual({ name: "skill_candidate_audit_log" });
        expect(table("agent_sessions")).toEqual({ name: "agent_sessions" });
        expect(table("activity_events")).toEqual({ name: "activity_events" });
        expect(versions).toEqual(migrations.map((migration) => ({ version: migration.version })));
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves existing relation rows when migration 5 rebuilds memory_relations", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-migration-data-"));
    const path = join(directory, "repomind.db");
    try {
      const legacy = legacyDatabase(path, 4);
      const now = 1_700_000_000_000;
      legacy.prepare("INSERT INTO repositories(id, name, created_at, updated_at) VALUES ('repo-1','demo',?,?)").run(now, now);
      const insertMemory = legacy.prepare(`
        INSERT INTO memories(id, repository_id, type, title, content, confidence, status, scope_type, scope_value,
          source, tags_json, fingerprint, created_at, updated_at, last_validated_at)
        VALUES (?, 'repo-1', 'decision', ?, ?, 1, ?, 'repository', NULL, 'manual', '[]', ?, ?, ?, ?)
      `);
      insertMemory.run("mem_new", "New decision", "The new decision.", "active", "fp-new", now, now, now);
      insertMemory.run("mem_old", "Old decision", "The old decision.", "superseded", "fp-old", now, now, now);
      legacy.prepare(`
        INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, created_at)
        VALUES ('mem_new','mem_old','supersedes',?)
      `).run(now);
      legacy.close();

      const upgraded = new Database(path);
      try {
        expect(upgraded.raw.prepare("SELECT version FROM schema_migrations WHERE version=5").get()).toEqual({ version: 5 });
        expect(upgraded.raw.prepare("SELECT * FROM memory_relations").all()).toEqual([{
          source_memory_id: "mem_new",
          target_memory_id: "mem_old",
          relation_type: "supersedes",
          created_at: now,
        }]);

        // The rebuild exists to widen the CHECK constraint; both types must work.
        upgraded.raw.prepare(`
          INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, created_at)
          VALUES ('mem_old','mem_new','contradicts',?)
        `).run(now);
        expect(upgraded.raw.prepare("SELECT count(*) AS count FROM memory_relations").get()).toEqual({ count: 2 });
        expect(() => upgraded.raw.prepare(`
          INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, created_at)
          VALUES ('mem_new','mem_old','invented',?)
        `).run(now)).toThrow();

        // Foreign keys and cascade behavior must survive the table swap.
        expect(() => upgraded.raw.prepare(`
          INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, created_at)
          VALUES ('mem_new','mem_missing','supersedes',?)
        `).run(now)).toThrow();
        upgraded.raw.prepare("DELETE FROM memories WHERE id='mem_old'").run();
        expect(upgraded.raw.prepare("SELECT count(*) AS count FROM memory_relations").get()).toEqual({ count: 0 });
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades every published schema fixture without losing governed data", { timeout: 30_000 }, () => {
    const releasedVersions = [...new Set(Object.values(releasedSchemas.releases))];
    for (const throughVersion of releasedVersions) {
      const directory = mkdtempSync(join(tmpdir(), `repomind-migration-v${throughVersion}-`));
      const path = join(directory, "repomind.db");
      try {
        const legacy = legacyDatabase(path, throughVersion);
        seedReleasedDatabase(legacy, throughVersion);
        legacy.close();
        const upgraded = new Database(path);
        try {
          const versions = upgraded.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
          expect(versions).toEqual(migrations.map((migration) => ({ version: migration.version })));
          expect(upgraded.raw.prepare("SELECT title, status FROM memories WHERE id='mem_release'").get())
            .toEqual({ title: "Released memory", status: "active" });
          expect(upgraded.raw.prepare("SELECT kind FROM evidence WHERE id='evd_release'").get())
            .toEqual({ kind: "test_result" });
          expect(upgraded.raw.prepare("SELECT action FROM memory_audit_log WHERE id='aud_release'").get())
            .toEqual({ action: "created" });
          expect(upgraded.raw.prepare("SELECT file_size, file_mtime_ms FROM memory_files WHERE memory_id='mem_release'").get())
            .toEqual({ file_size: 42, file_mtime_ms: 1_700_000_000_000 });
          if (throughVersion >= 7) expect(upgraded.raw.prepare("SELECT model FROM memory_embeddings WHERE memory_id='mem_release'").get()).toEqual({ model: "released-model" });
          if (throughVersion >= 8) expect(upgraded.raw.prepare("SELECT status FROM host_runs WHERE id='run_release'").get()).toEqual({ status: "committed" });
          if (throughVersion >= 9) expect(upgraded.raw.prepare("SELECT title FROM module_narratives WHERE id='l2_release'").get()).toEqual({ title: "Released module" });
          if (throughVersion >= 10) expect(upgraded.raw.prepare("SELECT title FROM repository_profiles WHERE id='l3_release'").get()).toEqual({ title: "Released profile" });
          if (throughVersion >= 11) expect(upgraded.raw.prepare("SELECT status FROM skill_candidates WHERE id='l4_release'").get()).toEqual({ status: "approved" });
          expect(upgraded.raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          expect(upgraded.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          upgraded.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("rolls back a failed upgrade, preserves data, and closes the rejected database", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-migration-failure-"));
    const path = join(directory, "repomind.db");
    const moved = join(directory, "rejected.db");
    try {
      const legacy = legacyDatabase(path, 5);
      legacy.prepare("INSERT INTO repositories(id, name, created_at, updated_at) VALUES ('repo_failure','failure-fixture',1,1)").run();
      legacy.exec("ALTER TABLE memory_files ADD COLUMN file_size INTEGER");
      legacy.close();

      expect(() => new Database(path)).toThrow(/duplicate column name/u);
      renameSync(path, moved);
      renameSync(moved, path);

      const rejected = new DatabaseSync(path);
      try {
        expect(rejected.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
        expect(rejected.prepare("SELECT name FROM repositories WHERE id='repo_failure'").get()).toEqual({ name: "failure-fixture" });
        expect(rejected.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        rejected.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills file size and mtime for memories created before migration 6", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-migration-files-"));
    const path = join(directory, "repomind.db");
    try {
      const legacy = legacyDatabase(path, 5);
      const columns = (legacy.prepare("PRAGMA table_info(memory_files)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).not.toContain("file_size");
      legacy.close();

      const upgraded = new Database(path);
      try {
        const upgradedColumns = (upgraded.raw.prepare("PRAGMA table_info(memory_files)").all() as Array<{ name: string }>).map((column) => column.name);
        expect(upgradedColumns).toEqual(expect.arrayContaining(["file_path", "file_hash", "file_size", "file_mtime_ms"]));
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
