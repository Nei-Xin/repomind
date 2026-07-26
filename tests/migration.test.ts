import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations.js";

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

describe("database migrations", () => {
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
