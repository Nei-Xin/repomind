import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureRepoMind,
  recordRepoMindTurn,
  repoMindBridgeStatus,
} from "../repomind/client.js";

afterEach(() => {
  vi.restoreAllMocks();
  configureRepoMind({ enabled: false, bridgeUrl: "", bridgeToken: "" });
});

describe("RepoMind Bridge client", () => {
  it("writes both sides of a turn with the configured identity and token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    configureRepoMind({
      enabled: true,
      bridgeUrl: "http://127.0.0.1:7345/",
      bridgeToken: "bridge-secret",
      timeoutMs: 1000,
    });

    await recordRepoMindTurn({
      sessionKey: "session-1",
      traceId: "trace-1",
      turnSeq: 3,
      userText: "Fix the parser",
      assistantText: "Parser fixed",
    });

    expect(repoMindBridgeStatus()).toEqual({ enabled: true, bridgeUrl: "http://127.0.0.1:7345" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[0]).toBe("http://127.0.0.1:7345/v1/activities");
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bridge-secret",
        },
      });
      const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: 1,
        agent: "claude",
        agentSessionId: "session-1",
        source: "memory-proxy",
        sequence: 3,
        type: expect.stringMatching(/^(user_message|assistant_message)$/u),
      });
    }
  });

  it("does not perform network work when disabled or when the session is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configureRepoMind({ enabled: false, bridgeUrl: "http://127.0.0.1:7345" });

    await recordRepoMindTurn({ sessionKey: "session-1", traceId: "trace-1", turnSeq: 0, userText: "hello" });
    await recordRepoMindTurn({ sessionKey: "  ", traceId: "trace-2", turnSeq: 0, userText: "hello" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a Bridge HTTP failure to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bridge unavailable", { status: 503 })));
    configureRepoMind({ enabled: true, bridgeUrl: "http://127.0.0.1:7345" });

    await expect(recordRepoMindTurn({
      sessionKey: "session-1",
      traceId: "trace-1",
      turnSeq: 1,
      userText: "hello",
    })).rejects.toThrow("HTTP 503");
  });
  it("falls back to the token file written by the RepoMind Bridge", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "memory-proxy-repomind-token-"));
    try {
      writeFileSync(join(dataDirectory, "bridge.token"), "file-token\n");
      vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
      vi.stubEnv("REPOMIND_BRIDGE_TOKEN", "");
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      configureRepoMind({ enabled: true, bridgeUrl: "http://127.0.0.1:7345", bridgeToken: "" });

      await recordRepoMindTurn({ sessionKey: "session-1", traceId: "trace-1", turnSeq: 0, userText: "hello" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
      expect(init.headers).toMatchObject({ authorization: "Bearer file-token" });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
