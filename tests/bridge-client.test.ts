import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postBridgeJson } from "../src/bridge/client.js";
import { ensureBridgeService } from "../src/services/manager.js";
import { execFileSync } from "node:child_process";

vi.mock("../src/services/manager.js", () => ({ ensureBridgeService: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "/runtime/node\n") }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => true }));

describe("interactive Bridge recovery boundary", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "repomind-client-"));
    vi.stubEnv("REPOMIND_DATA_DIR", directory);
    vi.stubEnv("REPOMIND_BRIDGE_TOKEN", "");
    vi.stubEnv("REPOMIND_BRIDGE_URL", "http://127.0.0.1:7345");
    vi.mocked(ensureBridgeService).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  const refused = () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  it("recovers a refused connection and retries with the newly generated token and unchanged event", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(Response.json({ stored: true }));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(ensureBridgeService).mockImplementation(async () => {
      writeFileSync(join(directory, "bridge.token"), "generated-test-token\n");
    });
    const body = { eventId: "stable-event", type: "tool_result" };
    expect(await postBridgeJson("/v1/activities", body)).toEqual({ stored: true });
    expect(ensureBridgeService).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map((call) => call[1].body)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
    expect(fetcher.mock.calls[1]![1].headers.authorization).toBe("Bearer generated-test-token");
  });

  it.each([
    ["authentication", () => Promise.resolve(Response.json({ error: { message: "unauthorized" } }, { status: 401 })), {}],
    ["timeout", () => Promise.reject(new DOMException("timeout", "TimeoutError")), {}],
    ["connection reset after submission", () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), {}],
    ["remote URL", () => Promise.reject(refused()), { bridgeUrl: "https://bridge.example.test" }],
    ["custom local port", () => Promise.reject(refused()), { bridgeUrl: "http://127.0.0.1:17456" }],
    ["explicit credentials", () => Promise.reject(refused()), { bridgeToken: "externally-managed" }],
  ] as const)("does not start a service or replay writes on %s", async (_label, response, options) => {
    const fetcher = vi.fn(response);
    vi.stubGlobal("fetch", fetcher);
    await expect(postBridgeJson("/v1/tasks/finish", { eventId: "finish" }, options)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ensureBridgeService).not.toHaveBeenCalled();
  });

  it("uses Node rather than the OpenCode executable when hosted by Bun", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "test" }, execPath: "/bin/opencode" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(Response.json({ ok: true })));
    await postBridgeJson("/v1/tasks/start", {});
    expect(execFileSync).toHaveBeenCalledWith("node", ["-p", "process.execPath"], expect.any(Object));
    expect(ensureBridgeService).toHaveBeenCalledWith(expect.objectContaining({ nodeExecutable: "/runtime/node" }));
  });

  it("surfaces startup failures without repeatedly sending the original request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(refused()));
    vi.mocked(ensureBridgeService).mockRejectedValue(new Error("port occupied"));
    await expect(postBridgeJson("/v1/tasks/start", {})).rejects.toThrow("port occupied");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
