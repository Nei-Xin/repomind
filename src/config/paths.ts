import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { RepoMindError } from "../errors.js";

export interface ProjectMarker {
  schemaVersion: 1;
  projectId: string;
  name: string;
}

export const markerPath = (repositoryRoot: string): string =>
  join(repositoryRoot, ".repomind", "project.json");

export function readProjectMarker(repositoryRoot: string): ProjectMarker {
  try {
    const marker = JSON.parse(readFileSync(markerPath(repositoryRoot), "utf8")) as ProjectMarker;
    if (marker.schemaVersion !== 1 || !marker.projectId || !marker.name) throw new Error("invalid marker");
    return marker;
  } catch (error) {
    throw new RepoMindError("REPOSITORY_NOT_INITIALIZED", `Run 'repomind init' in ${repositoryRoot}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function dataRoot(): string {
  return resolve(process.env.REPOMIND_DATA_DIR ?? join(homedir(), ".repomind"));
}

export function databasePath(projectId: string): string {
  const path = join(dataRoot(), "repositories", projectId, "repomind.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function canonicalPath(path: string): string {
  return realpathSync.native(resolve(path));
}
