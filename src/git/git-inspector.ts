import { execFileSync } from "node:child_process";
import { RepoMindError } from "../errors.js";
import type { GitSnapshot } from "../domain/types.js";

const MAX_OUTPUT = 1024 * 1024;

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw new RepoMindError("GIT_INSPECTION_FAILED", `git ${args.join(" ")} failed`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function locateGitRoot(path: string): string {
  const root = git(path, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new RepoMindError("NOT_A_GIT_REPOSITORY", `${path} is not a Git repository`);
  return root;
}

export function inspectGit(repositoryRoot: string): GitSnapshot {
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    branch: git(repositoryRoot, ["branch", "--show-current"], true) || null,
    head: git(repositoryRoot, ["rev-parse", "HEAD"], true) || null,
    dirty: status.length > 0,
    status,
  };
}

export function captureDiff(repositoryRoot: string, maxBytes = 65_536): { content: string; truncated: boolean } {
  const working = git(repositoryRoot, ["diff", "--no-ext-diff", "--unified=3"], true);
  const staged = git(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"], true);
  const content = [working, staged].filter(Boolean).join("\n\n--- staged ---\n\n");
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return { content, truncated: false };
  return { content: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}
