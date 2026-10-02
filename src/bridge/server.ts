import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError, type ZodTypeAny } from "zod";
import { InteractiveActivityStore } from "../activity/store.js";
import { RepoMindError } from "../errors.js";
import {
  abortInteractiveTaskSchema,
  finishInteractiveTaskSchema,
  recallInteractiveContextSchema,
  recordActivitySchema,
  registerAgentSessionSchema,
  startInteractiveTaskSchema,
} from "../protocol/activity.js";
import { redactSecrets } from "../security/redaction.js";

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
// Hostnames accepted in the Host header of a loopback Bridge, as URL.hostname
// reports them. Anything else indicates DNS rebinding or a misrouted request.
const LOOPBACK_HOST_HEADERS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  token?: string;
  dataDirectory?: string;
  onError?: (error: unknown) => void;
}

export interface RunningBridgeServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ErrorPayload {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

class SessionRepositoryRegistry {
  private readonly paths = new Map<string, string>();

  key(agent: string, agentSessionId: string): string {
    return `${agent}\0${agentSessionId}`;
  }

  set(agent: string, agentSessionId: string, repositoryPath: string): void {
    const key = this.key(agent, agentSessionId);
    const current = this.paths.get(key);
    if (current && current !== repositoryPath) {
      throw new RepoMindError(
        "INVALID_INPUT",
        `Agent session ${agentSessionId} is already bound to repository ${current}`,
      );
    }
    this.paths.set(key, repositoryPath);
  }

  get(agent: string, agentSessionId: string): string | null {
    return this.paths.get(this.key(agent, agentSessionId)) ?? null;
  }
}

function canonicalRepositoryPath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    // openRepository will return the detailed repository/path error later;
    // retaining the resolved path still prevents lexical aliases from
    // bypassing the session binding when the path exists.
    return resolved;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ZodError) {
    sendJson(response, 400, {
      error: { code: "INVALID_INPUT", message: "Request body failed validation", details: { issues: error.issues } },
    } satisfies ErrorPayload);
    return;
  }
  if (error instanceof RepoMindError) {
    const status = error.code === "SESSION_NOT_FOUND" ? 404
      : error.code === "SESSION_NOT_OPEN" ? 409
        : error.code === "REPOSITORY_NOT_INITIALIZED" || error.code === "NOT_A_GIT_REPOSITORY" ? 422
          : 400;
    sendJson(response, status, {
      error: {
        code: error.code,
        message: redactSecrets(error.message).content,
        ...(error.details ? { details: error.details } : {}),
      },
    } satisfies ErrorPayload);
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "RepoMind Bridge failed to process the request" },
  } satisfies ErrorPayload);
}

async function jsonBody<S extends ZodTypeAny>(request: IncomingMessage, schema: S): Promise<z.output<S>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RepoMindError("INVALID_INPUT", "Bridge request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RepoMindError("INVALID_INPUT", "Bridge request body must be valid JSON");
  }
  return schema.parse(parsed) as z.output<S>;
}

function bearerAuthorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const presented = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function hostHeaderName(request: IncomingMessage): string | null {
  const header = request.headers.host;
  if (!header) return null;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Rejects requests a web page could cause. Bridge clients are local processes
 * (hooks, plugins, MemoryProxy) that send no Origin or Fetch Metadata headers;
 * browsers always attach them to cross-site requests. The Host check defeats
 * DNS rebinding, where a page reaches loopback under its own hostname.
 */
function browserRequestRejection(request: IncomingMessage, loopback: boolean): ErrorPayload | null {
  if (loopback) {
    const hostname = hostHeaderName(request);
    if (!hostname || !LOOPBACK_HOST_HEADERS.has(hostname)) {
      return { error: { code: "FORBIDDEN_HOST", message: "Bridge only accepts requests addressed to a loopback host" } };
    }
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (request.headers.origin !== undefined || (fetchSite !== undefined && fetchSite !== "none")) {
    return { error: { code: "FORBIDDEN_ORIGIN", message: "Bridge does not accept browser cross-origin requests" } };
  }
  return null;
}

function isJsonRequest(request: IncomingMessage): boolean {
  const header = request.headers["content-type"];
  if (typeof header !== "string") return false;
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function repositoryFor(
  registry: SessionRepositoryRegistry,
  value: { agent: string; agentSessionId: string; repositoryPath?: string | undefined },
): string {
  if (value.repositoryPath) {
    const repositoryPath = canonicalRepositoryPath(value.repositoryPath);
    registry.set(value.agent, value.agentSessionId, repositoryPath);
    return repositoryPath;
  }
  const registered = registry.get(value.agent, value.agentSessionId);
  if (!registered) {
    throw new RepoMindError(
      "SESSION_NOT_FOUND",
      `Agent session ${value.agentSessionId} has not registered a repository path`,
    );
  }
  return registered;
}

function withStore<T>(
  repositoryPath: string,
  dataDirectory: string | undefined,
  work: (store: InteractiveActivityStore) => T,
): T {
  const store = new InteractiveActivityStore(repositoryPath, dataDirectory);
  try {
    return work(store);
  } finally {
    store.close();
  }
}

function normalizeHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

function displayHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<RunningBridgeServer> {
  const host = normalizeHost(options.host ?? "127.0.0.1");
  const port = options.port ?? 7345;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RepoMindError("INVALID_INPUT", `Bridge port must be an integer from 0 to 65535; received ${port}`);
  }
  if (!LOOPBACK_HOSTS.has(host) && !options.token) {
    throw new RepoMindError("INVALID_INPUT", "A bridge token is required when binding outside loopback");
  }
  const loopback = LOOPBACK_HOSTS.has(host);
  const registry = new SessionRepositoryRegistry();
  const server = createServer(async (request, response) => {
    try {
      const rejection = browserRequestRejection(request, loopback);
      if (rejection) {
        sendJson(response, 403, rejection);
        return;
      }
      if (!bearerAuthorized(request, options.token)) {
        sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Invalid Bridge bearer token" } });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", schemaVersion: 1 });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Bridge route was not found" } });
        return;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Bridge requests must use Content-Type: application/json" },
        });
        return;
      }
      if (url.pathname === "/v1/sessions/register") {
        const input = await jsonBody(request, registerAgentSessionSchema);
        const repositoryPath = canonicalRepositoryPath(input.repositoryPath);
        registry.set(input.agent, input.agentSessionId, repositoryPath);
        const result = withStore(input.repositoryPath, options.dataDirectory, (store) => store.register(input));
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/v1/tasks/start") {
        const input = await jsonBody(request, startInteractiveTaskSchema);
        const repository = repositoryFor(registry, input);
        const result = withStore(repository, options.dataDirectory, (store) => store.startTask(input));
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/v1/activities") {
        const input = await jsonBody(request, recordActivitySchema);
        const repository = repositoryFor(registry, input);
        const result = withStore(repository, options.dataDirectory, (store) => store.record(input));
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/v1/tasks/finish") {
        const input = await jsonBody(request, finishInteractiveTaskSchema);
        const repository = repositoryFor(registry, input);
        const result = withStore(repository, options.dataDirectory, (store) => store.finish(input));
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/v1/tasks/abort") {
        const input = await jsonBody(request, abortInteractiveTaskSchema);
        const repository = repositoryFor(registry, input);
        const result = withStore(repository, options.dataDirectory, (store) => store.abort(input));
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname === "/v1/recall") {
        const input = await jsonBody(request, recallInteractiveContextSchema);
        const repository = repositoryFor(registry, input);
        const result = withStore(repository, options.dataDirectory, (store) => store.recall(input));
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Bridge route was not found" } });
    } catch (error) {
      options.onError?.(error);
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge did not expose a TCP address");
  const url = `http://${displayHost(host)}:${address.port}`;
  return {
    server,
    host,
    port: address.port,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
