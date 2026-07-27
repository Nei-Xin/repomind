import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const targetArgument = process.argv[2];
if (!targetArgument) {
  throw new Error("Usage: node benchmarks/agent-suite/create.mjs <new-output-directory>");
}

const source = resolve(import.meta.dirname);
const target = resolve(targetArgument);
if (existsSync(target)) {
  throw new Error(`Refusing to overwrite existing suite directory: ${target}`);
}

mkdirSync(target, { recursive: false });
cpSync(join(source, "bases"), join(target, "bases"), { recursive: true });
cpSync(join(source, "hidden"), join(target, "hidden"), { recursive: true });

const baseDirectories = [
  "renamed-module", "failed-solution", "migration-rollback", "historical-command",
  "stale-endpoint", "error-contract", "dependency-boundary", "config-default",
];
const commits = new Map();
const fixedGitEnvironment = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
for (const name of baseDirectories) {
  const repository = join(target, "bases", name);
  writeFileSync(join(repository, ".gitattributes"), "* text eol=lf\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=RepoMind", "-c", "user.email=benchmark@repomind.local", "commit", "-q", "-m", "base fixture"], {
    cwd: repository, stdio: "pipe", env: fixedGitEnvironment,
  });
  commits.set(name, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim());
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.template.json"), "utf8"));
for (const task of manifest.tasks) {
  task.baseCommit = commits.get(task.id);
  for (const check of task.hiddenChecks) {
    check.args = check.args.map((argument) => argument.replaceAll("{suite}", target));
  }
}
writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(join(target, ".gitignore"), "results-*/\n", "utf8");

console.log(JSON.stringify({
  name: basename(target),
  root: target,
  manifest: join(target, "manifest.json"),
  repositories: Object.fromEntries(baseDirectories.map((name) => [name, {
    path: join(target, "bases", name), commit: commits.get(name),
  }])),
}, null, 2));
