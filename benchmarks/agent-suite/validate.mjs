import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "repomind-agent-fixtures-"));
const suite = join(root, "suite");

function run(command, args, cwd) {
  return spawnSync(command === "node" ? process.execPath : command, args, {
    cwd, encoding: "utf8", windowsHide: true, shell: false,
  });
}

try {
  const generator = resolve(import.meta.dirname, "create.mjs");
  const created = run(process.execPath, [generator, suite], process.cwd());
  if (created.status !== 0) throw new Error(created.stderr || created.stdout);
  const manifest = JSON.parse(readFileSync(join(suite, "manifest.json"), "utf8"));
  const results = [];
  for (const task of manifest.tasks) {
    const repository = resolve(suite, task.baseRepository);
    const head = run("git", ["rev-parse", "HEAD"], repository);
    if (head.status !== 0 || head.stdout.trim() !== task.baseCommit) throw new Error(`${task.id}: base commit mismatch`);
    for (const check of task.publicChecks) {
      const result = run(check.command, check.args.map((arg) => arg.replaceAll("{repo}", repository)), repository);
      if (result.status !== 0) throw new Error(`${task.id}: public check failed\n${result.stderr || result.stdout}`);
    }
    for (const check of task.hiddenChecks) {
      const result = run(check.command, check.args.map((arg) => arg.replaceAll("{repo}", repository)), repository);
      if (result.status === 0) throw new Error(`${task.id}: hidden check unexpectedly passes on the base fixture`);
    }
    results.push({ taskId: task.id, baseCommit: task.baseCommit, publicBaseline: "passed", hiddenBaseline: "failed-as-designed" });
  }
  console.log(JSON.stringify({ version: manifest.version, tasks: results }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
