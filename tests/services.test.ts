import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { servicesStatus, stopServices, type ServiceManagerOptions } from "../src/services/manager.js";

describe("service manager", () => {
  const scratchDirectories: string[] = [];

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function options(): ServiceManagerOptions {
    const dataDirectory = mkdtempSync(join(tmpdir(), "repomind-services-"));
    scratchDirectories.push(dataDirectory);
    return {
      dataDirectory,
      cliEntry: resolve("dist/cli/entry.js"),
      repoMindRoot: resolve("."),
    };
  }

  it("reports both services as unmanaged when no state exists", async () => {
    const result = await servicesStatus(options());
    expect(result.bridge).toMatchObject({ managed: false, pid: null, processRunning: false, owned: false });
    expect(result.memoryProxy).toMatchObject({ managed: false, pid: null, processRunning: false, owned: false });
  });

  it("refuses to stop a recorded PID whose command does not match", async () => {
    const managerOptions = options();
    const directory = join(managerOptions.dataDirectory!, "services");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state.json"), `${JSON.stringify({
      version: 1,
      services: {
        bridge: {
          pid: process.pid,
          startedAt: Date.now(),
          commandSignature: "definitely-not-the-current-process-command",
          url: "http://127.0.0.1:7345",
          logPath: join(directory, "bridge.log"),
        },
      },
    })}\n`, "utf8");

    const result = await stopServices(managerOptions);
    expect(result.actions.bridge).toBe("refused");
    expect(result.bridge).toMatchObject({ managed: true, pid: process.pid, processRunning: true, owned: false });
    const persisted = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as {
      services: { bridge?: { pid: number } };
    };
    expect(persisted.services.bridge?.pid).toBe(process.pid);
  });
});
