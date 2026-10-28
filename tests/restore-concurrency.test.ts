import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { backupRepository, restoreRepository } from "../src/portability/repository-data.js";
import { initializeRepository } from "../src/repository.js";
import { acquireDatabaseAccess } from "../src/storage/access.js";
import { Database } from "../src/storage/database.js";
import { createTestRepository } from "./helpers.js";

let repository: string;
let data: string;
beforeEach(() => {
  repository = createTestRepository();
  data = mkdtempSync(join(tmpdir(), "repomind-restore-access-"));
  process.env.REPOMIND_DATA_DIR = data;
  initializeRepository(repository).database.close();
});
afterEach(() => {
  delete process.env.REPOMIND_DATA_DIR;
  rmSync(repository, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

it.each([false, true])("blocks restore behind an idle MCP process, then permits it after exit (killed: %s)", async (killed) => {
  const core = new RepositoryMemoryCore(repository);
  const backupPath = join(data, "backup.db");
  core.record({ type: "decision", title: "Baseline", content: "Retained baseline." });
  backupRepository(core.context, backupPath);
  const newer = core.record({ type: "decision", title: "Newer decision", content: "Must survive rejected restore." });
  core.close();
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/cli/entry.js"), "mcp"],
    env: { ...process.env as Record<string, string>, REPOMIND_DATA_DIR: data }, stderr: "ignore" });
  const client = new Client({ name: "restore-concurrency", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "repo_memory_search", arguments: { repo_path: repository, query: "Newer decision" } });
    expect(JSON.stringify(result)).toContain(newer.id);
    expect(() => restoreRepository(repository, backupPath, { allowUnreadable: true })).toThrow(/database is in use/u);
    const unchanged = await client.callTool({ name: "repo_memory_search", arguments: { repo_path: repository, query: "Newer decision" } });
    expect(JSON.stringify(unchanged)).toContain(newer.id);
    if (killed) {
      const closed = new Promise<void>((done) => { client.onclose = done; });
      process.kill(transport.pid!, "SIGKILL");
      await closed;
    }
  } finally { await client.close(); }
  expect(restoreRepository(repository, backupPath).restored).toBe(true);
  const reopened = new RepositoryMemoryCore(repository);
  try {
    expect(reopened.search("Baseline")).toHaveLength(1);
    expect(reopened.search("Newer decision")).toHaveLength(0);
  } finally { reopened.close(); }
}, 15_000);

it("blocks new connections during exclusive access and releases the lock after a crash", async () => {
  const core = new RepositoryMemoryCore(repository);
  const path = core.context.database.path;
  core.close();
  const moduleUrl = pathToFileURL(resolve("dist/storage/access.js")).href;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireDatabaseAccess } from ${JSON.stringify(moduleUrl)};
      acquireDatabaseAccess(process.argv[1], true);
      console.log('ready'); setInterval(() => {}, 1000);
    `, path], { stdio: ["ignore", "pipe", "ignore"] });
    const ready = await Promise.race([
      once(child.stdout!, "data").then(([value]) => String(value).trim()),
      once(child, "exit").then(() => "exited before ready"),
    ]);
    expect(ready).toBe("ready");
    expect(() => new RepositoryMemoryCore(repository)).toThrow(/being restored/u);
    expect(() => acquireDatabaseAccess(path, true)).toThrow(/database is in use/u);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }
  const reopened = new RepositoryMemoryCore(repository);
  reopened.close();
}, 15_000);

it("releases access when opening an unreadable database fails", () => {
  const path = join(data, "unreadable.db");
  writeFileSync(path, "not a sqlite database");
  expect(() => new Database(path)).toThrow();
  const release = acquireDatabaseAccess(path, true);
  release();
});
