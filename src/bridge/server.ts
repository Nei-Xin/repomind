import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
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
    this.paths.set(this.key(agent, agentSessionId), repositoryPath);
  }

  get(agent: string, agentSessionId: string): string | null {
    return this.paths.get(this.key(agent, agentSessionId)) ?? null;
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
  return request.headers.authorization === `Bearer ${token}`;
}

function repositoryFor(
  registry: SessionRepositoryRegistry,
  value: { agent: string; agentSessionId: string; repositoryPath?: string | undefined },
): string {
  if (value.repositoryPath) {
    registry.set(value.agent, value.agentSessionId, value.repositoryPath);
    return value.repositoryPath;
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
  const registry = new SessionRepositoryRegistry();
  const server = createServer(async (request, response) => {
    try {
      if (!bearerAuthorized(request, options.token)) {
        sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Invalid Bridge bearer token" } });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", schemaVersion: 1 });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Bridge route was not found" } });
        return;
      }
      if (url.pathname === "/v1/sessions/register") {
        const input = await jsonBody(request, registerAgentSessionSchema);
        registry.set(input.agent, input.agentSessionId, input.repositoryPath);
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
