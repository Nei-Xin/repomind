import { execFileSync } from "node:child_process";
import { RepoMindError } from "../errors.js";
import type { GitSnapshot } from "../domain/types.js";

const MAX_OUTPUT = 1024 * 1024;

function git(cwd: string, args: string[], allowFailure = false, input?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
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

export function captureDiff(
  repositoryRoot: string,
  baselineHead: string | null,
  finalHead: string | null,
  maxBytes = 65_536,
): { content: string; truncated: boolean; sources: string[] } {
  const sections: Array<{ source: string; content: string }> = [];
  if (finalHead && baselineHead !== finalHead) {
    const emptyTree = baselineHead ? null : git(repositoryRoot, ["mktree"], true, "");
    const committed = git(
      repositoryRoot,
      ["diff", "--no-ext-diff", "--unified=3", baselineHead ?? emptyTree, finalHead].filter((value): value is string => Boolean(value)),
      true,
    );
    if (committed) sections.push({ source: "committed", content: committed });
  }
  const working = git(repositoryRoot, ["diff", "--no-ext-diff", "--unified=3"], true);
  const staged = git(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"], true);
  if (working) sections.push({ source: "working", content: working });
  if (staged) sections.push({ source: "staged", content: staged });
  const content = sections.map((section) => `--- ${section.source} ---\n${section.content}`).join("\n\n");
  const sources = sections.map((section) => section.source);
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return { content, truncated: false, sources };
  return { content: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, sources };
}
