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
  /**
   * Opt-in: route Claude's model traffic through MemoryProxy at this URL.
   * When omitted, Claude talks to its own endpoint and a project-level
   * ANTHROPIC_BASE_URL that RepoMind previously wrote for MemoryProxy is removed.
   */
  proxyUrl?: string;
}

export interface ClaudeProxyEnvironment {
  /** True when the project setting matches the requested routing. */
  configured: boolean;
  /** The project-level ANTHROPIC_BASE_URL after this operation. */
  value: string | null;
  /** The requested proxy URL, or null for direct (hooks-only) routing. */
  expected: string | null;
  /** True when the value is a RepoMind-managed MemoryProxy route. */
  legacyManagedProxy: boolean;
}

export interface InstallClaudeHooksResult {
  path: string;
  command: string;
  added: number;
  unchanged: number;
  proxyEnvironment: ClaudeProxyEnvironment & {
    changed: boolean;
    /** The legacy MemoryProxy route removed by this install, if any. */
    removed: string | null;
  };
}

export interface InspectClaudeHooksResult {
  path: string;
  installed: number;
  expected: number;
  missingEvents: string[];
  proxyEnvironment: ClaudeProxyEnvironment;
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

// Routes RepoMind's service manager configured for Claude before hooks-only
// integration: MemoryProxy's loopback port with its /claude-code/ prefix.
const MANAGED_PROXY_ROUTE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):8096\/claude-code(?:\/|$)/iu;

export function isRepoMindManagedProxyUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && MANAGED_PROXY_ROUTE.test(value.trim());
}

function proxyEnvironment(value: string | null, proxyUrl: string | undefined): ClaudeProxyEnvironment {
  const legacyManagedProxy = isRepoMindManagedProxyUrl(value);
  return {
    configured: proxyUrl === undefined ? !legacyManagedProxy : value === proxyUrl,
    value,
    expected: proxyUrl ?? null,
    legacyManagedProxy,
  };
}

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
  let nextProxy = currentProxy;
  let removed: string | null = null;
  if (options.proxyUrl !== undefined) {
    nextProxy = options.proxyUrl;
    environment.ANTHROPIC_BASE_URL = options.proxyUrl;
    settings.env = environment;
  } else if (isRepoMindManagedProxyUrl(currentProxy)) {
    // Hooks carry recall and capture now; a stale MemoryProxy route would make
    // every Claude request depend on a service that is no longer started.
    removed = currentProxy;
    nextProxy = null;
    delete environment.ANTHROPIC_BASE_URL;
    if (Object.keys(environment).length) settings.env = environment;
    else delete settings.env;
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
      ...proxyEnvironment(nextProxy, options.proxyUrl),
      changed: nextProxy !== currentProxy,
      removed,
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
    proxyEnvironment: proxyEnvironment(value, options.proxyUrl),
  };
}
