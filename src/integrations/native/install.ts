import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RepoMindError } from "../../errors.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { objectValue, type JsonObject, type NativeAgent } from "./client.js";

export interface NativeInstallOptions {
  agent: NativeAgent;
  repository: string;
  cliEntry: string;
  extensionEntry: string;
  nodeExecutable?: string;
}
const PI_MARKER = "// Managed by RepoMind: Pi native memory integration.";
const CODEX_MARKER = "RepoMind native memory";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];

function quoteShell(value: string): string {
  if (process.platform === "win32") {
    if (/[\r\n"%]/u.test(value)) throw new RepoMindError("INVALID_INPUT", "Unsupported character in Windows hook command path");
    return `"${value}"`;
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.repomind-${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}
function loadHooks(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
    const config = parsed as JsonObject;
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
      throw new Error("Expected hooks to be an object");
    }
    for (const value of Object.values(objectValue(config.hooks))) {
      if (!Array.isArray(value) || value.some(group => !Array.isArray(objectValue(group).hooks))) {
        throw new Error("Expected hook matcher groups with handler arrays");
      }
    }
    return config;
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Invalid Codex hooks file ${path}: ${String(error)}`);
  }
}
function expected(options: NativeInstallOptions) {
  const root = locateGitRoot(options.repository);
  const path = options.agent === "pi" ? join(root, ".pi", "extensions", "repomind.ts") : join(root, ".codex", "hooks.json");
  const command = [options.nodeExecutable ?? process.execPath, resolve(options.cliEntry), "codex-hook"].map(quoteShell).join(" ");
  const piSource = `${PI_MARKER}\n// Native import avoids transpiler copies of RepoMind's ESM dependency graph.\n`
    + `export default async function repomind(pi) {\n  const { default: install } = await import(${JSON.stringify(pathToFileURL(resolve(options.extensionEntry)).href)});\n  install(pi);\n}\n`;
  const handler = (event: string) => ({ type: "command", command, statusMessage: CODEX_MARKER,
    timeout: event === "Interrupt" || event === "SessionEnd" ? 3 : 60,
    ...(event === "UserPromptSubmit" ? { additionalContextLimit: 24_000 } : {}) });
  return { path, command, piSource, handler };
}
export function inspectNativeIntegration(options: NativeInstallOptions) {
  const target = expected(options);
  const exists = existsSync(target.path);
  if (options.agent === "pi") return {
    path: target.path, installed: exists, configured: exists && readFileSync(target.path, "utf8") === target.piSource,
    missingEvents: [] as string[],
  };
  const hooks = objectValue(loadHooks(target.path).hooks);
  const missingEvents = CODEX_EVENTS.filter(event => !(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [])
    .some(group => (objectValue(group).hooks as unknown[]).some(value => {
      const hook = objectValue(value);
      return objectValue(group).matcher === undefined && Object.entries(target.handler(event)).every(([key, expected]) => hook[key] === expected);
    })));
  return { path: target.path, installed: exists, configured: missingEvents.length === 0, missingEvents };
}
export function installNativeIntegration(options: NativeInstallOptions) {
  const target = expected(options);
  const entry = options.agent === "pi" ? options.extensionEntry : options.cliEntry;
  if (!existsSync(entry)) throw new RepoMindError("INVALID_INPUT", `RepoMind build entry missing: ${entry}`);
  const current = existsSync(target.path) ? readFileSync(target.path, "utf8") : null;
  let content = target.piSource;
  if (options.agent === "pi") {
    if (current !== null && !current.startsWith(PI_MARKER)) {
      throw new RepoMindError("INVALID_INPUT", `Refusing to replace unmanaged Pi extension: ${target.path}`);
    }
  } else {
    const config = loadHooks(target.path);
    const hooks = objectValue(config.hooks);
    for (const event of CODEX_EVENTS) {
      const groups = Array.isArray(hooks[event]) ? hooks[event] as JsonObject[] : [];
      const remaining = groups.map(group => ({ ...group, hooks: (group.hooks as JsonObject[])
        .filter(hook => !(hook.statusMessage === CODEX_MARKER && typeof hook.command === "string" && /['"]codex-hook['"]/u.test(hook.command))) }))
        .filter(group => group.hooks.length > 0);
      hooks[event] = [...remaining, { hooks: [target.handler(event)] }];
    }
    content = `${JSON.stringify({ ...config, hooks }, null, 2)}\n`;
  }
  const changed = current !== content;
  if (changed) atomicWrite(target.path, content);
  return { ...inspectNativeIntegration(options), changed };
}
