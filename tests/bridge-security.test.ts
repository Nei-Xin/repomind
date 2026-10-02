import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveActivityStore } from "../src/activity/store.js";
import { startBridgeServer, type RunningBridgeServer } from "../src/bridge/server.js";
import { bridgeTokenPath, ensureBridgeToken, readBridgeToken } from "../src/bridge/token.js";
import { handleClaudeInteractiveHook } from "../src/integrations/claude/interactive-hook.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const cleanup: string[] = [];
const running: RunningBridgeServer[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function initializedFixture(): { repository: string; dataDirectory: string } {
  const repository = createTestRepository("repomind-bridge-security-");
  cleanup.push(repository);
  const dataDirectory = scratch("repomind-bridge-security-data-");
  vi.stubEnv("REPOMIND_DATA_DIR", dataDirectory);
  initializeRepository(repository).database.close();
  return { repository, dataDirectory };
}

async function bridge(options: Parameters<typeof startBridgeServer>[0] = {}): Promise<RunningBridgeServer> {
  const server = await startBridgeServer({ port: 0, ...options });
  running.push(server);
  return server;
}

interface RawResponse {
  status: number;
  body: { error?: { code?: string } } & Record<string, unknown>;
}

/** Sends a request with exact headers; fetch() forbids overriding Host. */
function raw(
  server: RunningBridgeServer,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: server.port,
      method: options.method ?? "POST",
      path: options.path,
      headers: options.headers ?? {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function registration(repositoryPath: string, agentSessionId: string): string {
  return JSON.stringify({ schemaVersion: 1, agent: "claude", agentSessionId, repositoryPath });
}

describe("Bridge browser-request defenses", () => {
  it("rejects a no-CORS text/plain write and records nothing", async () => {
    const fixture = initializedFixture();
    const server = await bridge({ dataDirectory: fixture.dataDirectory });

    // The shape of a cross-site fetch(..., { mode: "no-cors" }) minus browser
    // headers: the media type alone must stop it.
    const smuggled = await raw(server, {
      path: "/v1/sessions/register",
      headers: { host: `127.0.0.1:${server.port}`, "content-type": "text/plain;charset=UTF-8" },
      body: registration(fixture.repository, "smuggled-session"),
    });
    expect(smuggled).toMatchObject({ status: 415, body: { error: { code: "UNSUPPORTED_MEDIA_TYPE" } } });

    const store = new InteractiveActivityStore(fixture.repository, fixture.dataDirectory);
    try {
      const sessions = store.core.context.database.raw.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
        count: number;
      };
      expect(sessions.count).toBe(0);
    } finally {
      store.close();
    }
  });

  it.each([
    { name: "missing content type", headers: {} },
    { name: "form encoding", headers: { "content-type": "application/x-www-form-urlencoded" } },
    { name: "JSON lookalike", headers: { "content-type": "application/jsonp" } },
  ])("requires application/json ($name)", async ({ headers }) => {
    const fixture = initializedFixture();
    const server = await bridge({ dataDirectory: fixture.dataDirectory });
    const response = await raw(server, {
      path: "/v1/sessions/register",
      headers: { host: `127.0.0.1:${server.port}`, ...headers },
      body: registration(fixture.repository, "media-type"),
    });
    expect(response.status).toBe(415);
  });

  it("accepts application/json with parameters", async () => {
    const fixture = initializedFixture();
    const server = await bridge({ dataDirectory: fixture.dataDirectory });
    const response = await raw(server, {
      path: "/v1/sessions/register",
      headers: { host: `localhost:${server.port}`, "content-type": "Application/JSON; charset=utf-8" },
      body: registration(fixture.repository, "json-with-charset"),
    });
    expect(response.status).toBe(200);
  });

  it.each([
    { name: "cross-site Origin", headers: { origin: "https://attacker.example" } },
    { name: "opaque Origin", headers: { origin: "null" } },
    { name: "loopback Origin", headers: { origin: "http://localhost:3000" } },
    { name: "Fetch Metadata without Origin", headers: { "sec-fetch-site": "cross-site" } },
  ])("rejects browser requests ($name) before authentication", async ({ headers }) => {
    const fixture = initializedFixture();
    const server = await bridge({ dataDirectory: fixture.dataDirectory, token: "secret-token" });
    const response = await raw(server, {
      path: "/v1/sessions/register",
      headers: {
        host: `127.0.0.1:${server.port}`,
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        ...headers,
      },
      body: registration(fixture.repository, "browser"),
    });
    expect(response).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN_ORIGIN" } } });
  });

  it("allows a user-typed health check (Sec-Fetch-Site: none)", async () => {
    const server = await bridge();
    const response = await raw(server, {
      method: "GET",
      path: "/health",
      headers: { host: `127.0.0.1:${server.port}`, "sec-fetch-site": "none" },
    });
    expect(response).toMatchObject({ status: 200, body: { status: "ok" } });
  });

  it.each([
    "attacker.example",
    `attacker.example:7345`,
    "127.0.0.1.attacker.example",
    "localhost.attacker.example",
  ])("rejects a non-loopback Host header (%s) to defeat DNS rebinding", async (host) => {
    const server = await bridge();
    const response = await raw(server, { method: "GET", path: "/health", headers: { host } });
    expect(response).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN_HOST" } } });
  });

  it.each(["127.0.0.1", "localhost", "LOCALHOST", "[::1]"])("accepts loopback Host %s", async (name) => {
    const server = await bridge();
    const response = await raw(server, { method: "GET", path: "/health", headers: { host: `${name}:${server.port}` } });
    expect(response.status).toBe(200);
  });

  it("still serves Node fetch clients, which send no browser headers", async () => {
    const server = await bridge({ token: "fetch-token" });
    const response = await fetch(`${server.url}/health`, { headers: { authorization: "Bearer fetch-token" } });
    expect(response.status).toBe(200);
  });

  it("compares bearer tokens exactly", async () => {
    const server = await bridge({ token: "exact-token" });
    for (const authorization of ["Bearer exact-toke", "Bearer exact-tokenX", "bearer exact-token", "exact-token"]) {
      const response = await raw(server, {
        method: "GET",
        path: "/health",
        headers: { host: `127.0.0.1:${server.port}`, authorization },
      });
      expect(response.status).toBe(401);
    }
    const accepted = await raw(server, {
      method: "GET",
      path: "/health",
      headers: { host: `127.0.0.1:${server.port}`, authorization: "Bearer exact-token" },
    });
    expect(accepted.status).toBe(200);
  });
});

describe("Bridge token file", () => {
  it("generates one owner-only token and reuses it", () => {
    const dataDirectory = scratch("repomind-bridge-token-");
    const env = {};
    expect(readBridgeToken({ dataDirectory, env })).toBeUndefined();

    const first = ensureBridgeToken({ dataDirectory, env });
    expect(first).toMatchObject({ source: "generated", path: bridgeTokenPath(dataDirectory) });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);

    const second = ensureBridgeToken({ dataDirectory, env });
    expect(second).toMatchObject({ source: "file", token: first.token });
    expect(readBridgeToken({ dataDirectory, env })).toBe(first.token);
  });

  it.skipIf(process.platform === "win32")("tightens a token file readable by other users", () => {
    const dataDirectory = scratch("repomind-bridge-token-mode-");
    writeFileSync(bridgeTokenPath(dataDirectory), "existing-token\n", { mode: 0o644 });
    expect(ensureBridgeToken({ dataDirectory, env: {} }).token).toBe("existing-token");
    expect(statSync(bridgeTokenPath(dataDirectory)).mode & 0o777).toBe(0o600);
  });

  it("prefers REPOMIND_BRIDGE_TOKEN and then does not write a file", () => {
    const dataDirectory = scratch("repomind-bridge-token-env-");
    const env = { REPOMIND_BRIDGE_TOKEN: "  from-env  " };
    expect(ensureBridgeToken({ dataDirectory, env })).toMatchObject({ source: "env", token: "from-env" });
    expect(readBridgeToken({ dataDirectory, env })).toBe("from-env");
    expect(readBridgeToken({ dataDirectory, env: {} })).toBeUndefined();
  });

  it("lets the Claude hook authenticate from the token file alone", async () => {
    const fixture = initializedFixture();
    vi.stubEnv("REPOMIND_BRIDGE_TOKEN", "");
    const { token } = ensureBridgeToken({ dataDirectory: fixture.dataDirectory });
    const server = await bridge({ dataDirectory: fixture.dataDirectory, token });
    const warnings: string[] = [];

    await handleClaudeInteractiveHook({
      bridgeUrl: server.url,
      input: { hook_event_name: "SessionStart", session_id: "token-file-session", cwd: fixture.repository },
      onWarning: (warning) => warnings.push(warning),
    });
    expect(warnings).toEqual([]);

    rmSync(bridgeTokenPath(fixture.dataDirectory));
    await handleClaudeInteractiveHook({
      bridgeUrl: server.url,
      input: { hook_event_name: "SessionStart", session_id: "token-file-session", cwd: fixture.repository },
      onWarning: (warning) => warnings.push(warning),
    });
    expect(warnings.join("\n")).toMatch(/bearer token/iu);
  });
});
