import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations.js";

describe("database migrations", () => {
  it("upgrades a version 1 database through every later migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-migration-"));
    const path = join(directory, "repomind.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      legacy.exec(migrations[0].sql);
      legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(Date.now());
      legacy.close();

      const upgraded = new Database(path);
      try {
        const columns = upgraded.raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
        const versions = upgraded.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
        const table = (name: string): unknown =>
          upgraded.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        expect(columns.map((column) => column.name)).toContain("status_reason_json");
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
});
