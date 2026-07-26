import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RepositoryMemoryCore } from "../../core.js";
import { RepoMindError } from "../../errors.js";
import { createScratchRepository, git } from "../scratch.js";
import { buildCorpus, renderDiff, type RawCorpus } from "./corpus.js";
import type { Fixture } from "./fixture.js";
import type { ContextRecord } from "./types.js";

export interface ReplayResult {
  fixture: Fixture;
  repositoryPath: string;
  corpus: RawCorpus;
  repoBase: ContextRecord[];
  repoFiles: Map<string, string>;
  core: RepositoryMemoryCore;
  corpusBuildFailed: boolean;
  buildError?: string;
  cleanup(): void;
}

function writeRepoFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function diffAgainstHead(root: string): string {
  return execFileSync("git", ["diff", "HEAD", "--no-ext-diff", "--unified=3"], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * The shared base every arm receives, so token deltas are attributable to the
 * memory layer rather than to how much repository context an arm happens to
 * include.
 */
function buildRepoBase(files: Map<string, string>): ContextRecord[] {
  const readme = files.get("README.md") ?? "";
  const packageJson = files.get("package.json") ?? "";
  let scripts = "";
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    if (parsed.scripts) scripts = `package.json scripts: ${JSON.stringify(parsed.scripts)}`;
  } catch {
    // A fixture without a parseable package.json simply contributes no scripts.
  }
  const tree = [...files.keys()]
    .filter((path) => path.split("/").length <= 2)
    .sort()
    .join("\n");
  const parts = [
    readme ? `README.md\n${readme.slice(0, 2048)}` : "",
    scripts,
    tree ? `Repository files:\n${tree}` : "",
  ].filter(Boolean);
  return parts.map((text) => ({ kind: "repo_base" as const, text }));
}

/**
 * One expensive pass per fixture: materializes the repository, replays every
 * history session through the public API, applies governance operations and
 * post-history mutations, and records the raw corpus alongside.
 *
 * Corpus construction is public-API-only, never direct SQL. That makes the
 * benchmark an integration test of the write path: a governance bug surfaces
 * as `corpusBuildFailed` rather than as a silently favorable zero.
 */
export function replayFixture(fixture: Fixture, placement?: "relevant-early" | "relevant-late"): ReplayResult {
  const repositoryPath = createScratchRepository("repomind-compare-");
  const files = new Map<string, string>(Object.entries(fixture.repo.files));
  let core: RepositoryMemoryCore | undefined;
  try {
    for (const [path, content] of files) writeRepoFile(repositoryPath, path, content);
    for (const commit of fixture.repo.commits) {
      git(repositoryPath, "add", ".");
      git(repositoryPath, "commit", "-q", "-m", commit.message);
    }

    core = new RepositoryMemoryCore(repositoryPath);
    const sessionDiffs = new Map<string, string | null>();
    const history = placement === "relevant-late" ? [...fixture.history].reverse() : fixture.history;

    for (const session of history) {
      const started = core.startSession({ task: session.task, clientName: "benchmark" });
      for (const [path, content] of Object.entries(session.edits ?? {})) {
        writeRepoFile(repositoryPath, path, content);
        files.set(path, content);
      }
      const patch = diffAgainstHead(repositoryPath);
      sessionDiffs.set(session.id, patch ? renderDiff(Object.keys(session.edits ?? {}), patch) : null);
      if (Object.keys(session.edits ?? {}).length) {
        git(repositoryPath, "add", ".");
        git(repositoryPath, "commit", "-q", "-m", `session ${session.id}`);
      }
      core.commitSession({
        sessionId: started.sessionId,
        idempotencyKey: `fixture-${fixture.name}-${session.id}`,
        status: session.status,
        summary: session.summary,
        ...(session.decisions ? { decisions: session.decisions } : {}),
        ...(session.tests ? { tests: session.tests } : {}),
        ...(session.commands ? { commands: session.commands } : {}),
      });
      // Notes are human knowledge the deterministic extractor cannot derive.
      // They always reach the raw corpus; they reach RepoMind only when the
      // fixture says a person recorded them.
      if (session.recordNotes) {
        for (const note of session.notes ?? []) {
          core.record({ type: "convention", title: note.slice(0, 96), content: note });
        }
      }
    }

    for (const operation of fixture.governanceOps ?? []) {
      const target = core.search(operation.targetTitle, { limit: 20 })
        .find((memory) => memory.title.toLowerCase().includes(operation.targetTitle.toLowerCase()));
      if (!target) throw new RepoMindError("INVALID_INPUT", `Governance op target not found: ${operation.targetTitle}`);
      if (operation.op === "invalidate") core.invalidateMemory({ memoryId: target.id, reason: operation.reason });
      else if (operation.op === "validate") core.validateMemory({ memoryId: target.id, reason: operation.reason });
      else {
        if (!operation.title || !operation.content) {
          throw new RepoMindError("INVALID_INPUT", `Correction needs title and content: ${operation.targetTitle}`);
        }
        core.correctMemory({ memoryId: target.id, reason: operation.reason, title: operation.title, content: operation.content });
      }
    }

    for (const mutation of fixture.mutations ?? []) {
      if (mutation.kind === "delete") {
        rmSync(join(repositoryPath, mutation.path), { force: true });
        files.delete(mutation.path);
      } else {
        writeRepoFile(repositoryPath, mutation.path, mutation.content ?? "");
        files.set(mutation.path, mutation.content ?? "");
      }
    }

    const corpus = buildCorpus({ ...fixture, history }, sessionDiffs);
    return {
      fixture,
      repositoryPath,
      corpus,
      repoBase: buildRepoBase(files),
      repoFiles: files,
      core,
      corpusBuildFailed: false,
      cleanup: () => {
        try {
          core?.close();
        } catch {
          // Already closed.
        }
        rmSync(repositoryPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      core?.close();
    } catch {
      // Already closed.
    }
    rmSync(repositoryPath, { recursive: true, force: true });
    throw error;
  }
}
