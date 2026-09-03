import { execFileSync } from "node:child_process";
import { RepoMindError } from "../errors.js";
import type { GitSnapshot } from "../domain/types.js";
import { SENSITIVE_PATH_GLOBS } from "../security/redaction.js";

const MAX_OUTPUT = 1024 * 1024;
const EXCLUDE_PATHSPECS = SENSITIVE_PATH_GLOBS.map((glob) => `:(exclude)${glob}`);
const WORKTREE_EXCLUDE_PATHSPECS = [...EXCLUDE_PATHSPECS, ":(exclude).repomind/**"];

export interface GitWorktreeFile {
  path: string;
  status: string;
  hash: string | null;
}

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
    }).trimEnd();
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

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

/** Returns the current dirty worktree state without exposing sensitive files. */
export function inspectWorktreeFiles(repositoryRoot: string): GitWorktreeFile[] {
  const output = git(repositoryRoot, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ...WORKTREE_EXCLUDE_PATHSPECS,
  ]);
  if (!output) return [];
  const fields = output.split("\0");
  const files: GitWorktreeFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3).replaceAll("\\", "/");
    if (status.includes("R") || status.includes("C")) index++;
    const objectHash = git(repositoryRoot, ["hash-object", "--", path], true) || null;
    files.push({ path, status, hash: objectHash });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Lists non-sensitive files changed by commits made during a session. */
export function filesChangedBetweenHeads(
  repositoryRoot: string,
  baselineHead: string | null,
  finalHead: string | null,
): string[] {
  if (!finalHead || baselineHead === finalHead) return [];
  const emptyTree = baselineHead ? null : git(repositoryRoot, ["mktree"], true, "");
  const range = [baselineHead ?? emptyTree, finalHead].filter((value): value is string => Boolean(value));
  const output = git(repositoryRoot, [
    "diff", "--name-only", "-z", ...range, "--", ".", ...WORKTREE_EXCLUDE_PATHSPECS,
  ], true);
  return output ? [...new Set(output.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/")))].sort() : [];
}

function sensitiveNames(repositoryRoot: string, rangeArgs: string[]): string[] {
  const output = git(repositoryRoot, ["diff", "--name-only", ...rangeArgs, "--", ...SENSITIVE_PATH_GLOBS], true);
  return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

export function captureDiff(
  repositoryRoot: string,
  baselineHead: string | null,
  finalHead: string | null,
  maxBytes = 65_536,
  files?: string[],
): { content: string; truncated: boolean; sources: string[]; excludedFiles: string[] } {
  const sections: Array<{ source: string; content: string }> = [];
  const excluded = new Set<string>();
  const includedPathspecs = files?.map(literalPathspec);
  if (includedPathspecs?.length === 0) {
    return { content: "", truncated: false, sources: [], excludedFiles: [] };
  }
  const pathspecs = includedPathspecs ?? [".", ...EXCLUDE_PATHSPECS];
  if (finalHead && baselineHead !== finalHead) {
    const emptyTree = baselineHead ? null : git(repositoryRoot, ["mktree"], true, "");
    const range = [baselineHead ?? emptyTree, finalHead].filter((value): value is string => Boolean(value));
    const committed = git(repositoryRoot, ["diff", "--no-ext-diff", "--unified=3", ...range, "--", ...pathspecs], true);
    if (committed) sections.push({ source: "committed", content: committed });
    for (const name of sensitiveNames(repositoryRoot, range)) excluded.add(name);
  }
  const working = git(repositoryRoot, ["diff", "--no-ext-diff", "--unified=3", "--", ...pathspecs], true);
  const staged = git(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", ...pathspecs], true);
  if (working) sections.push({ source: "working", content: working });
  if (staged) sections.push({ source: "staged", content: staged });
  for (const name of sensitiveNames(repositoryRoot, [])) excluded.add(name);
  for (const name of sensitiveNames(repositoryRoot, ["--cached"])) excluded.add(name);
  const content = sections.map((section) => `--- ${section.source} ---\n${section.content}`).join("\n\n");
  const sources = sections.map((section) => section.source);
  const excludedFiles = [...excluded].sort();
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return { content, truncated: false, sources, excludedFiles };
  return { content: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, sources, excludedFiles };
}
