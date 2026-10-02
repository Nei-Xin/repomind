import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataRoot } from "../config/paths.js";
import { RepoMindError } from "../errors.js";

/** Environment variable that overrides the generated Bridge token. */
export const BRIDGE_TOKEN_ENV = "REPOMIND_BRIDGE_TOKEN";
const TOKEN_FILE = "bridge.token";

export interface BridgeTokenOptions {
  /** RepoMind data directory; defaults to REPOMIND_DATA_DIR or ~/.repomind. */
  dataDirectory?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedBridgeToken {
  token: string;
  source: "env" | "file" | "generated";
  path: string;
}

export function bridgeTokenPath(dataDirectory?: string): string {
  return join(dataDirectory ? resolve(dataDirectory) : dataRoot(), TOKEN_FILE);
}

function readTokenFile(path: string): string | undefined {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RepoMindError("STORAGE_UNAVAILABLE", `Cannot read the RepoMind Bridge token at ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return value || undefined;
}

/**
 * Returns the token a Bridge client should present: the environment override
 * first, then the token file written by the Bridge. Clients never create the
 * file; a missing token means the Bridge has not started with token support.
 */
export function readBridgeToken(options: BridgeTokenOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const fromEnv = env[BRIDGE_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return readTokenFile(bridgeTokenPath(options.dataDirectory));
}

function restrictToOwner(path: string): void {
  if (process.platform === "win32") return;
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
}

/**
 * Returns the token the Bridge must require, generating a random owner-only
 * token file on first use. Concurrent first starts converge on one token.
 */
export function ensureBridgeToken(options: BridgeTokenOptions = {}): ResolvedBridgeToken {
  const path = bridgeTokenPath(options.dataDirectory);
  const env = options.env ?? process.env;
  const fromEnv = env[BRIDGE_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: "env", path };

  const existing = readTokenFile(path);
  if (existing) {
    restrictToOwner(path);
    return { token: existing, source: "file", path };
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new RepoMindError("STORAGE_UNAVAILABLE", `Cannot write the RepoMind Bridge token at ${path}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const raced = readTokenFile(path);
    if (!raced) throw new RepoMindError("STORAGE_UNAVAILABLE", `The RepoMind Bridge token at ${path} is empty`);
    return { token: raced, source: "file", path };
  }
  return { token, source: "generated", path };
}
