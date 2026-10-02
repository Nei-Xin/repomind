import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { migrations } from "./migrations.js";

export class Database {
  readonly raw: DatabaseSync;
  readonly vector: { available: boolean; version: string | null; error: string | null };
  private transactionDepth = 0;

  constructor(readonly path: string) {
    this.raw = new DatabaseSync(path, { allowExtension: true });
    try {
      this.raw.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      this.configureJournalMode();
      this.vector = this.loadVectorExtension();
      this.migrate();
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  private configureJournalMode(): void {
    // SQLite may return SQLITE_BUSY immediately during the initial WAL mode
    // transition even with busy_timeout configured. Retry that transition only.
    const deadline = Date.now() + 5000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        this.raw.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code === undefined || (code & 255) !== 5 || Date.now() >= deadline) throw error;
        Atomics.wait(wait, 0, 0, 10);
      }
    }
  }

  private loadVectorExtension(): { available: boolean; version: string | null; error: string | null } {
    try {
      sqliteVec.load(this.raw);
      const row = this.raw.prepare("SELECT vec_version() AS version").get() as { version: string };
      return { available: true, version: row.version, error: null };
    } catch (error) {
      return { available: false, version: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.raw.enableLoadExtension(false);
    }
  }

  private migrate(): void {
    // Read versions under the same write lock as DDL. Concurrent openers
    // must see migrations completed by the connection that acquired it first.
    this.transaction(() => {
      this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const applied = new Set(
        (this.raw.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
      );
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        this.raw.exec(migration.sql);
        this.raw.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
      }
    });
  }

  transaction<T>(work: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `repomind_nested_${depth}`;
    this.raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth = depth + 1;
    try {
      const result = work();
      this.raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (depth === 0) {
          this.raw.exec("ROLLBACK");
        } else {
          this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Transaction failed and rollback also failed", { cause: error });
      }
      throw error;
    } finally {
      // COMMIT/RELEASE can throw too; restore the entry depth exactly once.
      this.transactionDepth = depth;
    }
  }

  close(): void {
    this.raw.close();
  }
}
