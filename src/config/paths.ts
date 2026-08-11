import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { RepoMindError } from "../errors.js";

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProjectMarker {
  schemaVersion: 1;
  projectId: string;
  name: string;
}

export const markerPath = (repositoryRoot: string): string =>
  join(repositoryRoot, ".repomind", "project.json");

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

function assertStrictChild(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RepoMindError("PATH_OUTSIDE_REPOSITORY", "Database path must stay inside the RepoMind repositories data directory");
  }
}

function rejectLink(path: string): void {
  let symbolicLink = false;
  try {
    symbolicLink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (symbolicLink) {
    throw new RepoMindError("PATH_OUTSIDE_REPOSITORY", `Database path must not traverse a symbolic link or junction: ${path}`);
  }
}

export function readProjectMarker(repositoryRoot: string): ProjectMarker {
  try {
    const marker = JSON.parse(readFileSync(markerPath(repositoryRoot), "utf8")) as Partial<ProjectMarker>;
    if (marker.schemaVersion !== 1 || !validProjectId(marker.projectId) || typeof marker.name !== "string" || !marker.name) {
      throw new Error("invalid marker");
    }
    return marker as ProjectMarker;
  } catch (error) {
    throw new RepoMindError("REPOSITORY_NOT_INITIALIZED", `Run 'repomind init' in ${repositoryRoot}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function dataRoot(): string {
  return resolve(process.env.REPOMIND_DATA_DIR ?? join(homedir(), ".repomind"));
}

export function databasePath(projectId: string, rootDirectory = dataRoot()): string {
  if (!validProjectId(projectId)) {
    throw new RepoMindError("INVALID_INPUT", "projectId must be a canonical UUID");
  }

  const configuredRoot = resolve(rootDirectory);
  mkdirSync(configuredRoot, { recursive: true });
  const canonicalRoot = realpathSync.native(configuredRoot);
  const repositoriesRoot = resolve(configuredRoot, "repositories");
  assertStrictChild(configuredRoot, repositoriesRoot);
  rejectLink(repositoriesRoot);
  if (!existsSync(repositoriesRoot)) mkdirSync(repositoriesRoot);
  const canonicalRepositoriesRoot = realpathSync.native(repositoriesRoot);
  assertStrictChild(canonicalRoot, canonicalRepositoriesRoot);

  const projectDirectory = resolve(canonicalRepositoriesRoot, projectId);
  assertStrictChild(canonicalRepositoriesRoot, projectDirectory);
  rejectLink(projectDirectory);
  if (!existsSync(projectDirectory)) mkdirSync(projectDirectory);
  const canonicalProjectDirectory = realpathSync.native(projectDirectory);
  assertStrictChild(canonicalRepositoriesRoot, canonicalProjectDirectory);

  const path = resolve(canonicalProjectDirectory, "repomind.db");
  assertStrictChild(canonicalRepositoriesRoot, path);
  for (const sqlitePath of [path, `${path}-wal`, `${path}-shm`]) rejectLink(sqlitePath);
  if (existsSync(path)) {
    assertStrictChild(canonicalRepositoriesRoot, realpathSync.native(path));
  }
  return path;
}

export function canonicalPath(path: string): string {
  return realpathSync.native(resolve(path));
}
