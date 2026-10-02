import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrations } from "../src/storage/migrations.js";

it.each([0, 11])("serializes concurrent opens from schema %s", async (throughVersion) => {
  const directory = mkdtempSync(join(tmpdir(), "repomind-concurrent-migrations-"));
  const path = join(directory, "database.db");
  const workers: Worker[] = [];
  try {
    if (throughVersion) {
      const seed = new DatabaseSync(path);
      seed.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      for (const migration of migrations.filter((migration) => migration.version <= throughVersion)) {
        seed.exec(migration.sql);
        seed.prepare("INSERT INTO schema_migrations VALUES (?, 1)").run(migration.version);
      }
      seed.close();
    }
    const barrier = new SharedArrayBuffer(4);
    const flag = new Int32Array(barrier);
    let ready = 0;
    const moduleUrl = pathToFileURL(resolve("dist/storage/database.js")).href;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<unknown>((resolveResult, reject) => {
      const script = `
        import { parentPort, workerData } from 'node:worker_threads';
        import { Database } from ${JSON.stringify(moduleUrl)};
        parentPort.postMessage({ready:true});
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 5000);
        try { const db = new Database(workerData.path); db.close(); parentPort.postMessage({ok:true}); }
        catch (error) { parentPort.postMessage({ok:false,error:error.message}); }
      `;
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), { workerData: { path, barrier } });
      workers.push(worker);
      let result: unknown;
      worker.on("message", (message) => {
        if (message.ready) {
          if (++ready === 8) { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0, 8); }
        } else result = message;
      });
      worker.on("error", reject);
      worker.on("exit", (code) => code === 0 ? resolveResult(result) : reject(new Error(`Worker exited ${code}`)));
    })));
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
    const verified = new DatabaseSync(path);
    try {
      expect(verified.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toMatchObject({ count: migrations.length });
      expect(verified.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    } finally { verified.close(); }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});
