import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RepoMindError } from "../../errors.js";
import { locateGitRoot } from "../../git/git-inspector.js";

type JsonObject = Record<string, unknown>;

export interface InstallClaudeHooksOptions {
  repository: string;
  cliEntry: string;
  nodeExecutable?: string;
  bridgeUrl?: string;
  proxyUrl?: string;
}

export interface InstallClaudeHooksResult {
  path: string;
  command: string;
  added: number;
  unchanged: number;
  proxyEnvironment: { configured: boolean; changed: boolean; value: string | null };
}

export interface InspectClaudeHooksResult {
  path: string;
  installed: number;
  expected: number;
  missingEvents: string[];
  proxyEnvironment: { configured: boolean; value: string | null; expected: string | null };
}

interface HookDefinition {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout: number }>;
}

const EVENTS: ReadonlyArray<{ name: string; matcher?: string }> = [
  { name: "SessionStart" },
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: "Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell" },
  { name: "PostToolUse", matcher: "Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell" },
  { name: "PostToolUseFailure", matcher: "Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell" },
  { name: "Stop" },
  { name: "SessionEnd" },
];

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function quoteArgument(value: string): string {
  return JSON.stringify(value);
}

function hookCommand(options: InstallClaudeHooksOptions): string {
  const node = options.nodeExecutable ?? process.execPath;
  const url = options.bridgeUrl ?? "http://127.0.0.1:7345";
  return [node, resolve(options.cliEntry), "claude-hook", "--bridge-url", url]
    .map(quoteArgument)
    .join(" ");
}

function loadSettings(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    return objectValue(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Claude settings are not valid JSON: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function installClaudeInteractiveHooks(options: InstallClaudeHooksOptions): InstallClaudeHooksResult {
  const root = locateGitRoot(options.repository);
  const path = join(root, ".claude", "settings.local.json");
  const settings = loadSettings(path);
  const hooks = objectValue(settings.hooks);
  const command = hookCommand(options);
  let added = 0;
  let unchanged = 0;

  for (const event of EVENTS) {
    const existing = Array.isArray(hooks[event.name]) ? hooks[event.name] as HookDefinition[] : [];
    const present = existing.some((definition) => definition.hooks?.some((hook) => hook.command === command));
    if (present) {
      unchanged++;
      continue;
    }
    const definition: HookDefinition = {
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [{ type: "command", command, timeout: 10 }],
    };
    hooks[event.name] = [...existing, definition];
    added++;
  }

  settings.hooks = hooks;
  const environment = objectValue(settings.env);
  const currentProxy = typeof environment.ANTHROPIC_BASE_URL === "string"
    ? environment.ANTHROPIC_BASE_URL
    : null;
  const proxyChanged = options.proxyUrl !== undefined && currentProxy !== options.proxyUrl;
  if (options.proxyUrl !== undefined) {
    environment.ANTHROPIC_BASE_URL = options.proxyUrl;
    settings.env = environment;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.repomind-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
  return {
    path,
    command,
    added,
    unchanged,
    proxyEnvironment: {
      configured: options.proxyUrl === undefined ? currentProxy !== null : true,
      changed: proxyChanged,
      value: options.proxyUrl ?? currentProxy,
    },
  };
}

export function inspectClaudeInteractiveHooks(options: InstallClaudeHooksOptions): InspectClaudeHooksResult {
  const root = locateGitRoot(options.repository);
  const path = join(root, ".claude", "settings.local.json");
  const settings = loadSettings(path);
  const hooks = objectValue(settings.hooks);
  const command = hookCommand(options);
  const missingEvents = EVENTS.filter((event) => {
    const existing = Array.isArray(hooks[event.name]) ? hooks[event.name] as HookDefinition[] : [];
    return !existing.some((definition) => definition.hooks?.some((hook) => hook.command === command));
  }).map((event) => event.name);
  const environment = objectValue(settings.env);
  const value = typeof environment.ANTHROPIC_BASE_URL === "string" ? environment.ANTHROPIC_BASE_URL : null;
  return {
    path,
    installed: EVENTS.length - missingEvents.length,
    expected: EVENTS.length,
    missingEvents,
    proxyEnvironment: {
      configured: options.proxyUrl === undefined ? value !== null : value === options.proxyUrl,
      value,
      expected: options.proxyUrl ?? null,
    },
  };
}
