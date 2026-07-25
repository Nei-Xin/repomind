#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { RepositoryMemoryCore } from "../core.js";
import type { MemoryType } from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import { locateGitRoot } from "../git/git-inspector.js";
import { initializeRepository } from "../repository.js";
import { runMcpServer } from "../mcp/server.js";

const HELP = `RepoMind 0.1.0

Usage:
  repomind init [--repo <path>] [--new-id]
  repomind status [--repo <path>] [--json]
  repomind doctor [--repo <path>] [--json]
  repomind start --task <text> [--repo <path>] [--json]
  repomind commit --session <id> --key <key> --summary <text> [--status success|partial|failed] [--repo <path>] [--json]
  repomind search <query> [--repo <path>] [--limit <n>] [--json]
  repomind inspect <memory-id> [--repo <path>] [--json]
  repomind record --type <type> --title <text> --content <text> [--repo <path>] [--json]
  repomind sessions [--repo <path>] [--json]
  repomind session-abandon <session-id> [--repo <path>]
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
    help: { type: "boolean", short: "h", default: false },
  },
});

function required(value: string | undefined, flag: string): string {
  if (!value) throw new RepoMindError("INVALID_INPUT", `${flag} is required`);
  return value;
}

function output(value: unknown): void {
  if (values.json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
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
        type: required(values.type, "--type") as MemoryType,
        title: required(values.title, "--title"),
        content: required(values.content, "--content"),
      })); break;
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
  console.error(values.json ? JSON.stringify(payload) : `${payload.code}: ${payload.message}`);
  process.exitCode = 1;
});
