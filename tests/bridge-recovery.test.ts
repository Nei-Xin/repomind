import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBridgeService, servicesStatus, stopServices, type ServiceManagerOptions } from "../src/services/manager.js";
import { readBridgeToken } from "../src/bridge/token.js";

const execute = promisify(execFile);
const cleanup: ServiceManagerOptions[] = [];
afterEach(async () => {
  for (const options of cleanup.splice(0)) {
    await stopServices(options);
    rmSync(options.dataDirectory!, { recursive: true, force: true });
  }
});

async function fixture(): Promise<ServiceManagerOptions> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const options = { dataDirectory: mkdtempSync(join(tmpdir(), "repomind-recovery-")), bridgePort: port,
    cliEntry: resolve("dist/cli/entry.js"), repoMindRoot: resolve(".") };
  cleanup.push(options);
  return options;
}

describe("Bridge service recovery across processes", () => {
  it("starts one authenticated Bridge for simultaneous clients, then recovers after a crash", async () => {
    const options = await fixture();
    const moduleUrl = pathToFileURL(resolve("dist/services/manager.js")).href;
    const script = `import {ensureBridgeService,servicesStatus} from ${JSON.stringify(moduleUrl)};
      const options=JSON.parse(process.argv[1]); await ensureBridgeService(options);
      console.log(JSON.stringify((await servicesStatus(options)).bridge));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(options)], { timeout: 25_000 })));
    const statuses = results.map((result) => JSON.parse(result.stdout));
    expect(new Set(statuses.map((status) => status.pid)).size).toBe(1);
    expect(statuses.every((status) => status.healthy && status.owned)).toBe(true);
    const firstPid = statuses[0].pid as number;
    const token = readBridgeToken({ dataDirectory: options.dataDirectory });
    const unauthenticated = await fetch(statuses[0].url + "/health");
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.arrayBuffer();
    process.kill(firstPid, "SIGKILL");
    await expect.poll(async () => (await servicesStatus(options)).bridge.healthy).toBe(false);
    // Simulate a starter killed while owning its lifecycle lock.
    const lock = join(options.dataDirectory!, "services", "lifecycle.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: firstPid }));
    await ensureBridgeService(options);
    const recovered = (await servicesStatus(options)).bridge;
    expect(recovered.healthy).toBe(true);
    expect(recovered.pid).not.toBe(firstPid);
    expect(readBridgeToken({ dataDirectory: options.dataDirectory })).toBe(token);
  }, 30_000);

  it("reuses an authenticated Bridge without overwriting its owner record", async () => {
    const options = await fixture();
    await ensureBridgeService(options);
    const path = join(options.dataDirectory!, "services", "state.json");
    const before = readFileSync(path, "utf8");
    await ensureBridgeService({ ...options, cliEntry: resolve("other-installation/dist/cli/entry.js") });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not replace or terminate an unrelated listener", async () => {
    const options = await fixture();
    const server = createServer((_req, res) => { res.writeHead(401); res.end('{"error":"unauthorized"}'); });
    await new Promise<void>((done) => server.listen(options.bridgePort, "127.0.0.1", done));
    try {
      await expect(ensureBridgeService(options)).rejects.toThrow("unmanaged service");
      expect(server.listening).toBe(true);
      expect((await servicesStatus(options)).bridge.managed).toBe(false);
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});
