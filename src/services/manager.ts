import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ensureBridgeToken, readBridgeToken } from "../bridge/token.js";
import { dataRoot } from "../config/paths.js";
import { RepoMindError } from "../errors.js";

const BRIDGE_URL = "http://127.0.0.1:7345";
const MEMORY_PROXY_URL = "http://127.0.0.1:8096";
const STATE_VERSION = 1;

type ServiceName = "bridge" | "memoryProxy";

interface ServiceRecord {
  pid: number;
  startedAt: number;
  processStartedAt?: number;
  executable?: string;
  commandSignature: string;
  url: string;
  logPath: string;
}

interface ServiceState {
  version: 1;
  services: Partial<Record<ServiceName, ServiceRecord>>;
}

export interface ServiceStatus {
  name: ServiceName;
  managed: boolean;
  pid: number | null;
  processRunning: boolean;
  owned: boolean;
  healthy: boolean;
  httpStatus: number | null;
  url: string;
  logPath: string | null;
}

export interface ServicesResult {
  statePath: string;
  bridge: ServiceStatus;
  memoryProxy: ServiceStatus;
}

export interface ServiceManagerOptions {
  cliEntry: string;
  repoMindRoot: string;
  dataDirectory?: string;
  nodeExecutable?: string;
  bridgePort?: number;
}

interface ServiceDefinition {
  name: ServiceName;
  url: string;
  cwd: string;
  args: string[];
  commandSignature: string;
  logName: string;
  headers?: Record<string, string>;
}

function serviceDirectory(root?: string): string {
  return join(root ? resolve(root) : dataRoot(), "services");
}

function statePath(root?: string): string {
  return join(serviceDirectory(root), "state.json");
}

function emptyState(): ServiceState {
  return { version: STATE_VERSION, services: {} };
}

function readState(root?: string): ServiceState {
  const path = statePath(root);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceState>;
    if (parsed.version !== STATE_VERSION || !parsed.services || typeof parsed.services !== "object") return emptyState();
    return parsed as ServiceState;
  } catch {
    return emptyState();
  }
}

function writeState(state: ServiceState, root?: string): void {
  const directory = serviceDirectory(root);
  mkdirSync(directory, { recursive: true });
  const path = statePath(root);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function processRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // Detached children can remain zombies until the host's init reaps them.
      // They cannot serve requests and must not block a subsequent recovery.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^\s*[ZX]\s/u.test(stat.slice(stat.lastIndexOf(")") + 1))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ], {
        encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    }
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim() || null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function processIdentity(pid: number): { startedAt: number; executable: string } | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; @{startedAt=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds();executable=$p.Path}|ConvertTo-Json -Compress`,
    ], {
      encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = JSON.parse(output) as { startedAt?: unknown; executable?: unknown };
    return typeof parsed.startedAt === "number" && typeof parsed.executable === "string"
      ? { startedAt: parsed.startedAt, executable: parsed.executable }
      : null;
  } catch {
    return null;
  }
}

function normalizeCommand(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function canonicalEntry(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function ownedProcess(record: ServiceRecord, definition: ServiceDefinition): boolean {
  if (!processRunning(record.pid)) return false;
  if (normalizeCommand(canonicalEntry(record.commandSignature)) !== normalizeCommand(canonicalEntry(definition.commandSignature))) return false;
  const identity = processIdentity(record.pid);
  if (record.processStartedAt !== undefined && identity && record.processStartedAt !== identity.startedAt) return false;
  if (record.executable !== undefined && identity
    && normalizeCommand(record.executable) !== normalizeCommand(identity.executable)) return false;
  const commandLine = processCommandLine(record.pid);
  // Legacy records may have launched through a symlink. Compare the actual
  // command against that recorded spelling after checking canonical ownership.
  if (commandLine !== null) return normalizeCommand(commandLine).includes(normalizeCommand(record.commandSignature));
  return identity !== null
    && record.processStartedAt === identity.startedAt
    && record.executable !== undefined
    && normalizeCommand(record.executable) === normalizeCommand(identity.executable);
}

async function health(url: string, headers?: Record<string, string>): Promise<{ healthy: boolean; status: number | null }> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1_000),
      ...(headers ? { headers } : {}),
    });
    const body = await response.json().catch(() => null) as { status?: string; schemaVersion?: number } | null;
    return { healthy: response.ok && body?.status === "ok"
      && (!headers || body.schemaVersion === 1), status: response.status };
  } catch {
    return { healthy: false, status: null };
  }
}

function definitions(
  options: ServiceManagerOptions,
  token: string | undefined = readBridgeToken({ dataDirectory: options.dataDirectory }),
): Record<ServiceName, ServiceDefinition> {
  const cliEntry = canonicalEntry(options.cliEntry);
  const proxyRoot = resolve(options.repoMindRoot, "services", "memory-proxy");
  const proxyEntry = join(proxyRoot, "src", "index.ts");
  const proxyConfig = join(proxyRoot, "config.yaml");
  const bridgePort = options.bridgePort ?? 7345;
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    throw new RepoMindError("INVALID_INPUT", "Bridge service port must be between 1 and 65535");
  }
  return {
    bridge: {
      name: "bridge",
      url: `http://127.0.0.1:${bridgePort}`,
      cwd: resolve(options.repoMindRoot),
      args: [cliEntry, "bridge", "--host", "127.0.0.1", "--port", String(bridgePort)],
      commandSignature: cliEntry,
      logName: "bridge.log",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    },
    memoryProxy: {
      name: "memoryProxy",
      url: MEMORY_PROXY_URL,
      cwd: proxyRoot,
      args: ["--import", "tsx/esm", proxyEntry, "--config", proxyConfig, "--host", "127.0.0.1", "--port", "8096"],
      commandSignature: proxyEntry,
      logName: "memory-proxy.log",
    },
  };
}

function validateProxy(definition: ServiceDefinition): void {
  const config = join(definition.cwd, "config.yaml");
  const tsx = join(definition.cwd, "node_modules", "tsx");
  if (!existsSync(config)) {
    throw new RepoMindError("INVALID_INPUT", `MemoryProxy config is missing: ${config}`);
  }
  if (!existsSync(tsx)) {
    throw new RepoMindError("INVALID_INPUT", `MemoryProxy dependencies are missing; run npm install in ${definition.cwd}`);
  }
}

async function serviceStatus(definition: ServiceDefinition, record: ServiceRecord | undefined): Promise<ServiceStatus> {
  const running = record ? processRunning(record.pid) : false;
  const owned = record ? ownedProcess(record, definition) : false;
  const probe = await health(definition.url, definition.headers);
  return {
    name: definition.name,
    managed: record !== undefined,
    pid: record?.pid ?? null,
    processRunning: running,
    owned,
    healthy: probe.healthy,
    httpStatus: probe.status,
    url: definition.url,
    logPath: record?.logPath ?? null,
  };
}

export async function servicesStatus(options: ServiceManagerOptions): Promise<ServicesResult> {
  const state = readState(options.dataDirectory);
  const serviceDefinitions = definitions(options);
  const [bridge, memoryProxy] = await Promise.all([
    serviceStatus(serviceDefinitions.bridge, state.services.bridge),
    serviceStatus(serviceDefinitions.memoryProxy, state.services.memoryProxy),
  ]);
  return { statePath: statePath(options.dataDirectory), bridge, memoryProxy };
}

async function waitUntilReady(definition: ServiceDefinition, record: ServiceRecord): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!processRunning(record.pid)) {
      throw new RepoMindError("STORAGE_UNAVAILABLE", `${definition.name} exited during startup; inspect ${record.logPath}`);
    }
    const probe = await health(definition.url, definition.headers);
    if (probe.healthy) return;
    await new Promise((resolveReady) => setTimeout(resolveReady, 200));
  }
  throw new RepoMindError("STORAGE_UNAVAILABLE", `${definition.name} did not become healthy; inspect ${record.logPath}`);
}

function spawnService(definition: ServiceDefinition, options: ServiceManagerOptions, token: string): ServiceRecord {
  const directory = serviceDirectory(options.dataDirectory);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, definition.logName);
  const output = openSync(logPath, "a");
  let child;
  try {
    child = spawn(options.nodeExecutable ?? process.execPath, definition.args, {
      cwd: definition.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output, output],
      env: {
        ...process.env,
        REPOMIND_BRIDGE_URL: process.env.REPOMIND_BRIDGE_URL ?? BRIDGE_URL,
        // Both children share one token: the Bridge requires it and
        // MemoryProxy presents it on write-through.
        REPOMIND_BRIDGE_TOKEN: token,
        ...(options.dataDirectory ? { REPOMIND_DATA_DIR: resolve(options.dataDirectory) } : {}),
      },
    });
  } finally {
    closeSync(output);
  }
  if (!child.pid) throw new RepoMindError("STORAGE_UNAVAILABLE", `Failed to start ${definition.name}`);
  child.unref();
  const identity = processIdentity(child.pid);
  return {
    pid: child.pid,
    startedAt: Date.now(),
    ...(identity ? { processStartedAt: identity.startedAt, executable: identity.executable } : {}),
    commandSignature: definition.commandSignature,
    url: definition.url,
    logPath,
  };
}

async function stopRecord(record: ServiceRecord, definition: ServiceDefinition): Promise<"stopped" | "not-running" | "refused"> {
  if (!processRunning(record.pid)) return "not-running";
  if (!ownedProcess(record, definition)) return "refused";
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    return processRunning(record.pid) ? "refused" : "stopped";
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processRunning(record.pid)) {
    await new Promise((resolveStopped) => setTimeout(resolveStopped, 100));
  }
  return processRunning(record.pid) ? "refused" : "stopped";
}

export async function startServices(options: ServiceManagerOptions): Promise<ServicesResult> {
  return withServiceLock(options, () => startSelectedServices(options, ["bridge", "memoryProxy"]));
}

export async function startBridgeService(options: ServiceManagerOptions): Promise<ServicesResult> {
  return withServiceLock(options, () => startSelectedServices(options, ["bridge"]));
}

/** Reuse an authenticated Bridge, including one started by another installation. */
export async function ensureBridgeService(options: ServiceManagerOptions): Promise<void> {
  await withServiceLock(options, async () => {
    const definition = definitions(options).bridge;
    if (definition.headers && (await health(definition.url, definition.headers)).healthy) return;
    await startSelectedServices(options, ["bridge"]);
  });
}

/** Serialize starts and stops across hook processes and plugin instances. */
async function withServiceLock<T>(options: ServiceManagerOptions, work: () => Promise<T>): Promise<T> {
  const directory = serviceDirectory(options.dataDirectory);
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "lifecycle.lock");
  const owner = join(lock, "owner.json");
  const deadline = Date.now() + 20_000;
  const staleOwner = (modifiedAt?: number): boolean => {
    let pid: number | undefined;
    try { pid = (JSON.parse(readFileSync(owner, "utf8")) as { pid?: number }).pid; } catch { /* incomplete lock */ }
    return pid !== undefined ? !processRunning(pid) : Date.now() - (modifiedAt ?? statSync(lock).mtimeMs) > 30_000;
  };
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Only one contender may reclaim a dead owner's directory. Re-read the
    // owner after acquiring this guard so a replacement lock is never removed.
    const reaper = join(lock, "reaping");
    try {
      if (staleOwner()) {
        const previous = statSync(lock);
        mkdirSync(reaper);
        // Creating the guard changes directory mtime; use the original age
        // for an incomplete owner file. A live replacement must be left alone.
        const current = statSync(lock);
        if (current.ino === previous.ino && current.birthtimeMs === previous.birthtimeMs && staleOwner(previous.mtimeMs)) {
          rmSync(lock, { recursive: true, force: true });
        } else {
          rmSync(reaper, { recursive: true, force: true });
        }
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // A process killed during synchronous stale-lock reclamation may leave
      // the guard behind. Give it a grace period before permitting a retry.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          if (Date.now() - statSync(reaper).mtimeMs > 30_000) rmSync(reaper, { recursive: true, force: true });
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
    }
    if (Date.now() >= deadline) throw new RepoMindError("STORAGE_UNAVAILABLE", "Timed out waiting for RepoMind service startup; run 'repomind doctor' to inspect the Bridge");
    await new Promise((done) => setTimeout(done, 50));
  }
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function startSelectedServices(
  options: ServiceManagerOptions,
  selected: readonly ServiceName[],
): Promise<ServicesResult> {
  const state = readState(options.dataDirectory);
  const { token } = ensureBridgeToken({ dataDirectory: options.dataDirectory });
  const serviceDefinitions = definitions(options, token);
  if (selected.includes("memoryProxy")) validateProxy(serviceDefinitions.memoryProxy);
  const started: ServiceName[] = [];
  try {
    for (const name of selected) {
      const definition = serviceDefinitions[name];
      const existing = state.services[name];
      if (existing && ownedProcess(existing, definition)) {
        const probe = await health(definition.url, definition.headers);
        if (!probe.healthy) {
          throw new RepoMindError("STORAGE_UNAVAILABLE", `${name} is running but unhealthy; inspect ${existing.logPath}`);
        }
        continue;
      }
      if ((await health(definition.url, definition.headers)).status !== null) {
        throw new RepoMindError("INVALID_INPUT", `${definition.url} is already in use by an unmanaged service`);
      }
      delete state.services[name];
      const record = spawnService(definition, options, token);
      state.services[name] = record;
      writeState(state, options.dataDirectory);
      started.push(name);
      await waitUntilReady(definition, record);
    }
  } catch (error) {
    for (const name of [...started].reverse()) {
      const record = state.services[name];
      if (record) await stopRecord(record, serviceDefinitions[name]);
      delete state.services[name];
    }
    writeState(state, options.dataDirectory);
    throw error;
  }
  return servicesStatus(options);
}

export async function stopServices(options: ServiceManagerOptions): Promise<ServicesResult & {
  actions: Record<ServiceName, "stopped" | "not-running" | "refused">;
}> {
  return withServiceLock(options, () => stopServicesUnlocked(options));
}

async function stopServicesUnlocked(options: ServiceManagerOptions): ReturnType<typeof stopServices> {
  const state = readState(options.dataDirectory);
  const serviceDefinitions = definitions(options);
  const actions: Record<ServiceName, "stopped" | "not-running" | "refused"> = {
    bridge: "not-running",
    memoryProxy: "not-running",
  };
  for (const name of ["memoryProxy", "bridge"] as const) {
    const record = state.services[name];
    if (!record) continue;
    actions[name] = await stopRecord(record, serviceDefinitions[name]);
    if (actions[name] !== "refused") delete state.services[name];
  }
  writeState(state, options.dataDirectory);
  return { ...(await servicesStatus(options)), actions };
}
