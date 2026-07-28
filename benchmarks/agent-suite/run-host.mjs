import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runHostAcceptance } from "../../dist/eval/agent/host-acceptance.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    workspace: { type: "string" },
    model: { type: "string" },
    "runner-executable": { type: "string" },
    timeout: { type: "string" },
    strict: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.workspace) {
  console.log("Usage: node benchmarks/agent-suite/run-host.mjs --workspace <new-directory> [--model <id>] [--runner-executable <path>] [--timeout <ms>] [--strict]");
  process.exitCode = values.help ? 0 : 1;
} else {
  const workspace = resolve(values.workspace);
  if (existsSync(workspace)) throw new Error(`Refusing to overwrite existing acceptance workspace: ${workspace}`);
  const timeoutMs = values.timeout === undefined ? 600_000 : Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error(`Invalid --timeout ${values.timeout}`);
  mkdirSync(workspace, { recursive: false });
  const suite = resolve(workspace, "suite");
  const created = spawnSync(process.execPath, [resolve(import.meta.dirname, "create.mjs"), suite], {
    cwd: resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (created.status !== 0) throw new Error(created.stderr || created.stdout || "Unable to create the eight-task suite");

  const report = await runHostAcceptance({
    manifestPath: resolve(suite, "manifest.json"),
    outputDirectory: resolve(workspace, "results"),
    ...(values.model ? { model: values.model } : {}),
    ...(values["runner-executable"] ? { runnerExecutable: values["runner-executable"] } : {}),
    timeoutMs,
    onStatus: (message) => console.error(`[RepoMind acceptance] ${message}`),
  });
  console.log(JSON.stringify({
    workspace,
    summary: resolve(workspace, "results", "summary.json"),
    accepted: report.totals.accepted,
    tasks: report.totals.tasks,
    integrity: report.integrity.passed,
    acceptance: report.acceptance.passed,
  }, null, 2));
  if (values.strict && (!report.integrity.passed || !report.acceptance.passed)) process.exitCode = 1;
}
