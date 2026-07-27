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

const baseDirectories = ["renamed-module", "failed-solution", "migration-rollback", "historical-command"];
for (const name of baseDirectories) {
  const repository = join(target, "bases", name);
  execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=RepoMind", "-c", "user.email=benchmark@repomind.local", "commit", "-q", "-m", "base fixture"], {
    cwd: repository, stdio: "pipe",
  });
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.template.json"), "utf8"));
for (const task of manifest.tasks) {
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
  repositories: baseDirectories.map((name) => join(target, "bases", name)),
}, null, 2));
