import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBridgeToken } from "./token.js";
import { ensureBridgeService } from "../services/manager.js";

export interface BridgeClientOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  timeoutMs?: number;
  /** Short shutdown hooks cannot wait for managed service recovery. */
  recover?: boolean;
}

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: unknown; errors?: unknown[] };
  return value.code === "ECONNREFUSED" || connectionRefused(value.cause)
    || (Array.isArray(value.errors) && value.errors.length > 0 && value.errors.every(connectionRefused));
}

function managedEndpoint(base: string): boolean {
  // Explicit remote endpoints and custom ports are never started or replaced.
  return base === "http://127.0.0.1:7345" || base === "http://localhost:7345";
}

async function recoverBridge(): Promise<void> {
  const cliEntry = fileURLToPath(new URL("../cli/entry.js", import.meta.url));
  if (!existsSync(cliEntry)) throw new Error("RepoMind build is missing; run 'npm run build' and re-run setup");
  // OpenCode embeds Bun: process.execPath there is the OpenCode executable,
  // which must never be launched with RepoMind's Node CLI arguments.
  const nodeExecutable = process.versions.bun
    ? execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 3_000, windowsHide: true }).trim()
    : process.execPath;
  await ensureBridgeService({ cliEntry, repoMindRoot: resolve(dirname(cliEntry), "../.."), nodeExecutable });
}

/** Retry only a refused connection, before a request could reach the server. */
export async function postBridgeJson<T>(path: string, body: Record<string, unknown>, options: BridgeClientOptions = {}): Promise<T> {
  const base = (options.bridgeUrl ?? process.env.REPOMIND_BRIDGE_URL ?? "http://127.0.0.1:7345").replace(/\/+$/u, "");
  const request = async (): Promise<T> => {
    // Recovery may create the token file for the first time.
    const token = options.bridgeToken ?? readBridgeToken();
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    const result = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `Bridge returned HTTP ${response.status}`);
    return result;
  };
  try { return await request(); } catch (error) {
    if (options.recover === false || !managedEndpoint(base) || options.bridgeToken !== undefined || !connectionRefused(error)) throw error;
    await recoverBridge();
    return request();
  }
}

export function bridgeUnavailableMessage(error: unknown): string {
  return `RepoMind memory is unavailable for this operation; automatic recall or recording was skipped. `
    + `You can continue working. Run 'repomind doctor' or re-run the client setup to repair it. `
    + `Details: ${error instanceof Error ? error.message : String(error)}`;
}
