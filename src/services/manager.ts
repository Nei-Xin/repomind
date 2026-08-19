import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

function ownedProcess(record: ServiceRecord, definition: ServiceDefinition): boolean {
  if (!processRunning(record.pid)) return false;
  if (normalizeCommand(record.commandSignature) !== normalizeCommand(definition.commandSignature)) return false;
  const identity = processIdentity(record.pid);
  if (record.processStartedAt !== undefined && identity && record.processStartedAt !== identity.startedAt) return false;
  if (record.executable !== undefined && identity
    && normalizeCommand(record.executable) !== normalizeCommand(identity.executable)) return false;
  const commandLine = processCommandLine(record.pid);
  if (commandLine !== null) return normalizeCommand(commandLine).includes(normalizeCommand(definition.commandSignature));
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
    return { healthy: response.ok, status: response.status };
  } catch {
    return { healthy: false, status: null };
  }
}

function definitions(options: ServiceManagerOptions): Record<ServiceName, ServiceDefinition> {
  const cliEntry = resolve(options.cliEntry);
  const proxyRoot = resolve(options.repoMindRoot, "services", "memory-proxy");
  const proxyEntry = join(proxyRoot, "src", "index.ts");
  const proxyConfig = join(proxyRoot, "config.yaml");
  const token = process.env.REPOMIND_BRIDGE_TOKEN;
  return {
    bridge: {
      name: "bridge",
      url: BRIDGE_URL,
      cwd: resolve(options.repoMindRoot),
      args: [cliEntry, "bridge", "--host", "127.0.0.1", "--port", "7345"],
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

function spawnService(definition: ServiceDefinition, options: ServiceManagerOptions): ServiceRecord {
  const directory = serviceDirectory(options.dataDirectory);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, definition.logName);
  const output = openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, definition.args, {
      cwd: definition.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output, output],
      env: {
        ...process.env,
        REPOMIND_BRIDGE_URL: process.env.REPOMIND_BRIDGE_URL ?? BRIDGE_URL,
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
  const state = readState(options.dataDirectory);
  const serviceDefinitions = definitions(options);
  validateProxy(serviceDefinitions.memoryProxy);
  const started: ServiceName[] = [];
  try {
    for (const name of ["bridge", "memoryProxy"] as const) {
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
      const record = spawnService(definition, options);
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
