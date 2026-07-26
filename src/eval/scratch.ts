import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryMemoryCore } from "../core.js";
import { initializeRepository } from "../repository.js";

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Creates an initialized throwaway Git repository with a deterministic identity. */
export function createScratchRepository(prefix = "repomind-eval-repo-"): string {
  const repository = mkdtempSync(join(tmpdir(), prefix));
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.email", "repomind-eval@example.invalid");
  git(repository, "config", "user.name", "RepoMind Eval");
  initializeRepository(repository).database.close();
  return repository;
}

/** Opens cores that the scratch owner closes, so a throwing caller cannot
 * leave a SQLite handle open and turn cleanup into an unrelated EBUSY error. */
export type OpenCore = (repositoryPath: string) => RepositoryMemoryCore;

/**
 * Runs `work` against fresh repositories and a fresh data directory, restoring
 * `REPOMIND_DATA_DIR` and deleting everything afterwards. Results never depend
 * on, and never touch, the caller's real memories.
 */
export function withScratch<T>(repositoryCount: number, work: (repositories: string[], openCore: OpenCore) => T): T {
  const data = mkdtempSync(join(tmpdir(), "repomind-eval-data-"));
  const previousDataDir = process.env.REPOMIND_DATA_DIR;
  const opened: RepositoryMemoryCore[] = [];
  process.env.REPOMIND_DATA_DIR = data;
  const repositories: string[] = [];
  try {
    for (let index = 0; index < repositoryCount; index++) repositories.push(createScratchRepository());
    return work(repositories, (repositoryPath) => {
      const core = new RepositoryMemoryCore(repositoryPath);
      opened.push(core);
      return core;
    });
  } finally {
    for (const core of opened) {
      try {
        core.close();
      } catch {
        // Already closed by the caller; cleanup must not mask the real error.
      }
    }
    if (previousDataDir === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previousDataDir;
    for (const repository of repositories) rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}
