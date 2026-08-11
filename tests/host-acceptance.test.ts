import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostAcceptance } from "../src/eval/agent/host-acceptance.js";
import type { OpenCodeProcessExecutor, OpenCodeProcessResult } from "../src/integrations/opencode/run.js";

function writeSolution(repository: string): void {
  const task = repository.replaceAll("\\", "/").split("/").at(-1);
  switch (task) {
    case "renamed-module":
      writeFileSync(join(repository, "src", "index.js"), "export const version = \"1.0.0\";\nexport { serializeAuditRecord } from \"./history/audit-record.js\";\n", "utf8");
      break;
    case "failed-solution":
      writeFileSync(join(repository, "src", "delivery.js"), `const delivered = new Set();

export async function deliverOnce(id, send) {
  if (delivered.has(id)) return false;
  delivered.add(id);
  try { await send(id); return true; }
  catch (error) { delivered.delete(id); throw error; }
}

export function resetDeliveries() { delivered.clear(); }
`, "utf8");
      break;
    case "migration-rollback":
      writeFileSync(join(repository, "migrations", "20260727-user-handle.js"), `export async function up(db) {
  await db.exec("ALTER TABLE users ADD COLUMN handle TEXT");
  await db.exec("CREATE UNIQUE INDEX users_handle_uq ON users(handle)");
}
export async function down(db) {
  await db.exec("DROP INDEX users_handle_uq");
  await db.exec("ALTER TABLE users DROP COLUMN handle");
}
`, "utf8");
      break;
    case "historical-command": {
      const path = join(repository, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> };
      pkg.scripts["verify:release"] = "node --test && node scripts/check-schema.mjs";
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      break;
    }
    case "stale-endpoint":
      writeFileSync(join(repository, "src", "client.js"), "export function jobsEndpoint() {\n  return \"/v2/tasks\";\n}\n", "utf8");
      break;
    case "error-contract":
      writeFileSync(join(repository, "src", "parse-config.js"), `export function parseConfig(text) {
  try { return JSON.parse(text); }
  catch (cause) { const error = new SyntaxError("Invalid config", { cause }); error.code = "CONFIG_PARSE_FAILED"; throw error; }
}
`, "utf8");
      break;
    case "dependency-boundary":
      writeFileSync(join(repository, "src", "digest.js"), "import { createHash } from \"node:crypto\";\nexport function stableDigest(value) { return createHash(\"sha256\").update(value, \"utf8\").digest(\"hex\"); }\n", "utf8");
      break;
    case "config-default":
      writeFileSync(join(repository, "src", "config.js"), "export function requestTimeout(environment = {}) {\n  return Number(environment.REQUEST_TIMEOUT_MS ?? 5_000);\n}\n", "utf8");
      break;
    default:
      throw new Error(`Unknown fixture ${task}`);
  }
}

function processResult(stdout: string): OpenCodeProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 10,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

describe("eight-task host-run acceptance", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("rebuilds and accepts all eight tasks through the daily host runner", async () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-acceptance-"));
    const suite = join(scratch, "suite");
    const generator = spawnSync(process.execPath, [resolve("benchmarks/agent-suite/create.mjs"), suite], {
      cwd: resolve("."),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    expect(generator.status, generator.stderr || generator.stdout).toBe(0);

    const executeAgent: OpenCodeProcessExecutor = async (request) => {
      writeSolution(request.cwd);
      const events = [
        { type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "node --test" }, output: "tests passed", metadata: { exit: 0 } } } },
        { type: "text", part: { text: "Implemented and verified the requested fixture change." } },
        { type: "step_finish", part: { reason: "stop" } },
      ];
      return processResult(`${events.map(JSON.stringify).join("\n")}\n`);
    };
    const output = join(scratch, "results");
    const report = await runHostAcceptance({
      manifestPath: join(suite, "manifest.json"),
      outputDirectory: output,
      model: "test/model",
      executeAgent,
    });

    expect(report.integrity).toEqual({ passed: true, failures: [] });
    expect(report.acceptance).toEqual({ passed: true, failures: [] });
    expect(report.totals).toEqual({
      tasks: 8,
      accepted: 8,
      retrieved: 8,
      committed: 8,
      publicPassed: 8,
      hiddenPassed: 8,
    });
    expect(report.tasks.every((task) => task.run?.agent.events.repoMindCalls === 0)).toBe(true);
    expect(report.tasks.every((task) => {
      const layer = task.run?.context.l2;
      return layer !== undefined && layer.eligible >= 1 && layer.injected + layer.deduplicated === layer.eligible;
    })).toBe(true);
    const l3Layers = report.tasks.map((task) => task.run?.context.l3).filter((layer) => layer !== undefined);
    expect(l3Layers.some((layer) => layer.eligible === 1)).toBe(true);
    expect(l3Layers.every((layer) => {
      return layer.eligible === 0 || layer.injected + layer.deduplicated === layer.eligible;
    })).toBe(true);
    expect(report.tasks.every((task) => task.openSessions === 0 && task.artifactsVerified)).toBe(true);
    expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8"))).toMatchObject({ version: 1, totals: { accepted: 8 } });
    expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("Acceptance: **passed**");
  }, 90_000);
});
