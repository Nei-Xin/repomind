import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function createTestRepository(prefix = "repomind-repo-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "repomind-test@example.invalid");
  git(root, "config", "user.name", "RepoMind Test");
  writeFileSync(join(root, "README.txt"), "initial\n", "utf8");
  git(root, "add", "README.txt");
  git(root, "commit", "-m", "initial");
  return root;
}
