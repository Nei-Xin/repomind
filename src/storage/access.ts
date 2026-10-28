import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, rmSync } from "node:fs";
import { RepoMindError } from "../errors.js";

/**
 * A separate rollback-journal database coordinates connection lifetimes, not
 * individual queries. Shared readers permit normal concurrent WAL activity;
 * an exclusive reader prevents physical restore while any connection is open.
 * SQLite releases these OS locks even when a process is killed. Never remove
 * this sidecar while clients may be running, or replace it during restore.
 */
export function acquireDatabaseAccess(path: string, exclusive = false): () => void {
  if (path === ":memory:") return () => {};
  let lock: DatabaseSync | undefined;
  try {
    const accessPath = `${path}.access.sqlite`;
    if (!existsSync(accessPath)) {
      // Publish a complete header without taking a write lock on a sidecar
      // another opener may already be reading. link() never replaces a winner.
      const temporary = `${accessPath}.init-${process.pid}-${randomUUID()}`;
      try {
        const seed = new DatabaseSync(temporary);
        try { seed.exec("PRAGMA user_version = 1"); } finally { seed.close(); }
        try { linkSync(temporary, accessPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        rmSync(temporary, { force: true });
        rmSync(`${temporary}-journal`, { force: true });
      }
    }
    lock = new DatabaseSync(accessPath);
    if (lock.prepare("PRAGMA journal_mode").get()!.journal_mode !== "delete") {
      throw new Error("Database access coordination requires DELETE journal mode");
    }
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec(exclusive ? "BEGIN EXCLUSIVE" : "BEGIN");
    lock.prepare("SELECT count(*) FROM sqlite_schema").get();
    const connection = lock;
    return () => connection.close();
  } catch (error) {
    lock?.close();
    throw new RepoMindError("STORAGE_UNAVAILABLE", exclusive
      ? "Repository database is in use. Close RepoMind MCP clients and active tasks, stop the Bridge, then retry restore."
      : "Repository database is unavailable or being restored. Retry after restore finishes.",
    { cause: error instanceof Error ? error.message : String(error) });
  }
}
