import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { canonicalPath, databasePath, markerPath, readProjectMarker, type ProjectMarker } from "./config/paths.js";
import { locateGitRoot } from "./git/git-inspector.js";
import { Database } from "./storage/database.js";

export interface RepositoryContext {
  root: string;
  marker: ProjectMarker;
  checkoutId: string;
  database: Database;
}

function checkoutId(root: string): string {
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  return `chk_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function initializeRepository(path: string, newId = false): RepositoryContext {
  const root = canonicalPath(locateGitRoot(path));
  const pathToMarker = markerPath(root);
  let marker: ProjectMarker;
  if (existsSync(pathToMarker) && !newId) {
    marker = readProjectMarker(root);
  } else {
    marker = { schemaVersion: 1, projectId: randomUUID(), name: basename(root) };
    mkdirSync(dirname(pathToMarker), { recursive: true });
    writeFileSync(pathToMarker, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: newId ? "w" : "wx" });
  }
  return openRepository(root, marker);
}

export function openRepository(path: string, knownMarker?: ProjectMarker, dataDirectory?: string): RepositoryContext {
  const root = canonicalPath(locateGitRoot(path));
  const marker = knownMarker ?? readProjectMarker(root);
  const database = new Database(databasePath(marker.projectId, dataDirectory));
  const id = checkoutId(root);
  const now = Date.now();
  database.transaction(() => {
    database.raw.prepare(`
      INSERT INTO repositories(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).run(marker.projectId, marker.name, now, now);
    database.raw.prepare(`
      INSERT INTO repository_checkouts(id, repository_id, root_path, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(root_path) DO UPDATE SET repository_id=excluded.repository_id, last_seen_at=excluded.last_seen_at
    `).run(id, marker.projectId, root, now);
  });
  return { root, marker, checkoutId: id, database };
}

export function readRawMarker(path: string): ProjectMarker {
  return JSON.parse(readFileSync(markerPath(path), "utf8")) as ProjectMarker;
}
