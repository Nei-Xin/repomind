#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { RepositoryMemoryCore } from "../core.js";
import type { MemoryType } from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import { locateGitRoot } from "../git/git-inspector.js";
import { initializeRepository } from "../repository.js";
import { runMcpServer } from "../mcp/server.js";
import { VERSION } from "../version.js";
import { loadDataset } from "../eval/dataset.js";
import { evaluateDataset } from "../eval/runner.js";
import { runScenarioSuite } from "../eval/scenarios.js";
import { readCommitInput } from "./commit-input.js";
import { stringifyCliJson } from "./json.js";

const MEMORY_TYPES = ["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"] as const;

const HELP = `RepoMind ${VERSION}

Usage:
  repomind init [--repo <path>] [--new-id]
  repomind status [--repo <path>] [--json]
  repomind doctor [--repo <path>] [--json]
  repomind start --task <text> [--repo <path>] [--json]
  repomind commit --input <result.json|-> [--repo <path>] [--json]
  repomind commit --session <id> --key <key> --summary <text> [--status success|partial|failed] [--repo <path>] [--json]
  repomind search <query> [--repo <path>] [--limit <n>] [--json]
  repomind inspect <memory-id> [--repo <path>] [--json]
  repomind record --type <type> --title <text> --content <text> [--repo <path>] [--json]
  repomind memory-validate <memory-id> --reason <text> [--repo <path>] [--json]
  repomind memory-correct <memory-id> --reason <text> --title <text> --content <text> [--type <type>] [--repo <path>] [--json]
  repomind memory-invalidate <memory-id> --reason <text> [--repo <path>] [--json]
  repomind forget <memory-id> --reason <text> [--scope memory|memory-and-evidence] --yes [--repo <path>] [--json]
  repomind sessions [--repo <path>] [--json]
  repomind session-abandon <session-id> [--repo <path>]
  repomind eval (--dataset <path> | --scenarios) [--limit <n>] [--json]
  repomind mcp
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    repo: { type: "string" },
    json: { type: "boolean", default: false },
    "new-id": { type: "boolean", default: false },
    task: { type: "string" },
    session: { type: "string" },
    key: { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    limit: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    reason: { type: "string" },
    input: { type: "string" },
    scope: { type: "string" },
    yes: { type: "boolean", default: false },
    dataset: { type: "string" },
    scenarios: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function required(value: string | undefined, flag: string): string {
  if (!value) throw new RepoMindError("INVALID_INPUT", `${flag} is required`);
  return value;
}

function memoryType(value: string | undefined, flag: string): MemoryType {
  const candidate = required(value, flag);
  if (!MEMORY_TYPES.includes(candidate as MemoryType)) throw new RepoMindError("INVALID_INPUT", `Invalid ${flag} ${candidate}`);
  return candidate as MemoryType;
}

function output(value: unknown): void {
  if (values.json || typeof value !== "string") console.log(stringifyCliJson(value));
  else console.log(value);
}

function repositoryPath(): string {
  return values.repo ?? process.cwd();
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  if (command === "init") {
    const context = initializeRepository(repositoryPath(), values["new-id"]);
    try {
      output({ projectId: context.marker.projectId, repositoryRoot: context.root, databasePath: context.database.path });
    } finally {
      context.database.close();
    }
    return;
  }
  if (command === "eval") {
    if (values.scenarios) {
      output(runScenarioSuite());
      return;
    }
    const dataset = loadDataset(required(values.dataset, "--dataset"));
    const limit = values.limit ? Number(values.limit) : 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RepoMindError("INVALID_INPUT", `Invalid --limit ${values.limit}`);
    output(evaluateDataset(dataset, limit));
    return;
  }
  if (command === "doctor") {
    const checks: Record<string, unknown> = { node: process.version, sqlite: true, fts5: false, git: false, initialized: false };
    const memory = new DatabaseSync(":memory:");
    try {
      memory.exec("CREATE VIRTUAL TABLE check_fts USING fts5(content)");
      checks.fts5 = true;
    } finally {
      memory.close();
    }
    try { checks.gitRoot = locateGitRoot(repositoryPath()); checks.git = true; } catch { /* reported below */ }
    try {
      const core = new RepositoryMemoryCore(repositoryPath());
      checks.initialized = true;
      checks.projectId = core.context.marker.projectId;
      core.close();
    } catch { /* an uninitialized repository is a valid diagnostic result */ }
    output(checks);
    return;
  }

  const core = new RepositoryMemoryCore(repositoryPath());
  try {
    switch (command) {
      case "status": output(core.status()); break;
      case "start": output(core.startSession({ task: required(values.task, "--task"), clientName: "cli" })); break;
      case "commit": {
        if (values.input) {
          if (values.session || values.key || values.summary || values.status) {
            throw new RepoMindError("INVALID_INPUT", "--input cannot be combined with --session, --key, --summary, or --status");
          }
          output(core.commitSession(readCommitInput(values.input)));
          break;
        }
        const status = values.status ?? "success";
        if (!(["success", "partial", "failed"] as const).includes(status as "success")) throw new RepoMindError("INVALID_INPUT", `Invalid --status ${status}`);
        output(core.commitSession({
          sessionId: required(values.session, "--session"),
          idempotencyKey: required(values.key, "--key"),
          status: status as "success" | "partial" | "failed",
          summary: required(values.summary, "--summary"),
        }));
        break;
      }
      case "search": output(core.search(required(positionals[1], "query"), { limit: values.limit ? Number(values.limit) : 5 })); break;
      case "inspect": output(core.inspect(required(positionals[1], "memory-id"))); break;
      case "record": output(core.record({
        type: memoryType(values.type, "--type"),
        title: required(values.title, "--title"),
        content: required(values.content, "--content"),
      })); break;
      case "memory-validate": output(core.validateMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
      })); break;
      case "memory-correct": output(core.correctMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
        title: required(values.title, "--title"),
        content: required(values.content, "--content"),
        ...(values.type ? { type: memoryType(values.type, "--type") } : {}),
      })); break;
      case "memory-invalidate": output(core.invalidateMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
      })); break;
      case "forget": {
        const memoryId = required(positionals[1], "memory-id");
        const scope = values.scope ?? "memory-and-evidence";
        if (!(["memory", "memory-and-evidence"] as const).includes(scope as "memory")) {
          throw new RepoMindError("INVALID_INPUT", `Invalid --scope ${scope}`);
        }
        const reason = required(values.reason, "--reason");
        if (!values.yes) {
          const details = core.inspect(memoryId);
          output({
            wouldDelete: {
              memoryId,
              type: details.type,
              title: details.title,
              scope,
              linkedEvidence: (details.evidence as unknown[]).length,
            },
            hint: "This permanently deletes the memory" +
              (scope === "memory-and-evidence" ? " and any evidence used only by it" : "") +
              ". Re-run with --yes to confirm.",
          });
          process.exitCode = 1;
          break;
        }
        output(core.forgetMemory({ memoryId, reason, scope: scope as "memory" | "memory-and-evidence" }));
        break;
      }
      case "sessions": output(core.listSessions()); break;
      case "session-abandon": core.abandonSession(required(positionals[1], "session-id")); output("Session abandoned."); break;
      default: throw new RepoMindError("INVALID_INPUT", `Unknown command: ${command}`);
    }
  } finally {
    core.close();
  }
}

main().catch((error: unknown) => {
  const payload = error instanceof RepoMindError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  console.error(values.json ? stringifyCliJson(payload) : `${payload.code}: ${payload.message}`);
  process.exitCode = 1;
});
