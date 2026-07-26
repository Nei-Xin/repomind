import { copyFileSync, existsSync, rmSync } from "node:fs";
import type { RepositoryMemoryCore } from "../../core.js";

const WAL_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Captures the database so each arm can start from identical state.
 *
 * This is not optional. `core.search` refreshes staleness, which *writes*
 * `uncertain` statuses, while the no-governance arm reads statuses without
 * refreshing. Sharing one database would make arm execution order perturb the
 * governance delta the ablation exists to measure — and a two-identical-runs
 * determinism test would pass straight through the bug.
 *
 * WAL mode means the live `.db` file alone is not the database: a checkpoint
 * has to fold the log back in, and the sidecar files are copied with it.
 */
export function snapshotDatabase(core: RepositoryMemoryCore): DatabaseSnapshot {
  core.context.database.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const path = core.context.database.path;
  for (const suffix of WAL_SUFFIXES) {
    const source = `${path}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${source}.snapshot`);
    else rmSync(`${source}.snapshot`, { force: true });
  }
  return new DatabaseSnapshot(path);
}

export class DatabaseSnapshot {
  constructor(readonly path: string) {}

  /** Restores the snapshot. The core must be closed before calling this. */
  restore(): void {
    for (const suffix of WAL_SUFFIXES) {
      const target = `${this.path}${suffix}`;
      const source = `${target}.snapshot`;
      if (existsSync(source)) copyFileSync(source, target);
      else rmSync(target, { force: true });
    }
  }

  cleanup(): void {
    for (const suffix of WAL_SUFFIXES) rmSync(`${this.path}${suffix}.snapshot`, { force: true });
  }
}
