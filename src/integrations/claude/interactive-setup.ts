import { resolve } from "node:path";
import { RepositoryMemoryCore } from "../../core.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { initializeRepository } from "../../repository.js";
import {
  servicesStatus,
  startBridgeService,
  startServices,
  type ServiceManagerOptions,
  type ServicesResult,
} from "../../services/manager.js";
import { createClaudeHostAdapter } from "./adapter.js";
import {
  inspectClaudeInteractiveHooks,
  installClaudeInteractiveHooks,
  type InspectClaudeHooksResult,
  type InstallClaudeHooksResult,
} from "./hook-installer.js";

/**
 * MemoryProxy route used by `--proxy-url` deployments. Claude integration is
 * hooks-only by default and does not route model traffic through a proxy.
 */
export const DEFAULT_CLAUDE_PROXY_URL = "http://127.0.0.1:8096/claude-code/default";

export interface ClaudeInteractiveOptions extends ServiceManagerOptions {
  repository: string;
  /** Opt-in MemoryProxy route; omit for the default hooks-only integration. */
  proxyUrl?: string;
  runnerExecutable?: string;
}

export interface ClaudeInteractiveStatus {
  ready: boolean;
  repository: { root: string; initialized: boolean; projectId: string | null };
  claude: { executable: string; available: boolean; version: string | null };
  hooks: InspectClaudeHooksResult;
  services: ServicesResult;
  warnings: string[];
  nextSteps: string[];
}

function hookOptions(options: ClaudeInteractiveOptions) {
  return {
    repository: options.repository,
    cliEntry: options.cliEntry,
    bridgeUrl: "http://127.0.0.1:7345",
    ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {}),
  };
}

const REMOVED_PROXY_WARNING = "RepoMind removed its MemoryProxy route (ANTHROPIC_BASE_URL) from "
  + ".claude/settings.local.json. Claude now uses your user-level endpoint; if MemoryProxy forwarded to "
  + "a custom upstream, set ANTHROPIC_BASE_URL to that upstream in your own Claude settings.";

export async function claudeInteractiveStatus(options: ClaudeInteractiveOptions): Promise<ClaudeInteractiveStatus> {
  const root = locateGitRoot(options.repository);
  let projectId: string | null = null;
  try {
    const core = new RepositoryMemoryCore(root, {
      ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
    });
    projectId = core.context.marker.projectId;
    core.close();
  } catch {
    // Report initialization as a diagnostic state below.
  }
  const hooks = inspectClaudeInteractiveHooks({ ...hookOptions(options), repository: root });
  const services = await servicesStatus(options);
  const adapter = createClaudeHostAdapter({
    ...(options.runnerExecutable ? { executable: options.runnerExecutable } : {}),
  });
  const version = await adapter.version(root);
  const proxied = options.proxyUrl !== undefined;
  const setupCommand = `repomind claude setup --repo ${JSON.stringify(root)}`
    + (proxied ? ` --proxy-url ${JSON.stringify(options.proxyUrl)}` : "");
  const nextSteps = [
    ...(projectId ? [] : [`Run '${setupCommand}'.`]),
    ...(hooks.installed === hooks.expected && hooks.proxyEnvironment.configured
      ? []
      : [`Run '${setupCommand}' to repair Claude hooks and model routing.`]),
    ...(services.bridge.healthy ? [] : [`Run '${setupCommand}' or start the RepoMind Bridge.`]),
    ...(proxied && !services.memoryProxy.healthy ? ["Run 'repomind services start' to start MemoryProxy."] : []),
    ...(version ? [] : ["Install Claude Code or add the claude executable to PATH."]),
  ];
  const warnings = !proxied && hooks.proxyEnvironment.legacyManagedProxy
    ? ["Claude still routes through RepoMind's legacy MemoryProxy route; setup will remove it."]
    : [];
  const uniqueNextSteps = [...new Set(nextSteps)];
  return {
    ready: uniqueNextSteps.length === 0,
    repository: { root, initialized: projectId !== null, projectId },
    claude: { executable: adapter.executable, available: version !== null, version },
    hooks,
    services,
    warnings,
    nextSteps: uniqueNextSteps,
  };
}

export async function setupClaudeInteractive(options: ClaudeInteractiveOptions): Promise<{
  projectId: string;
  hooks: InstallClaudeHooksResult;
  services: ServicesResult;
  status: ClaudeInteractiveStatus;
}> {
  const root = resolve(locateGitRoot(options.repository));
  const context = initializeRepository(root);
  const projectId = context.marker.projectId;
  context.database.close();
  const hooks = installClaudeInteractiveHooks({ ...hookOptions(options), repository: root });
  const services = options.proxyUrl !== undefined
    ? await startServices(options)
    : await startBridgeService(options);
  const status = await claudeInteractiveStatus({ ...options, repository: root });
  if (hooks.proxyEnvironment.removed) status.warnings = [...status.warnings, REMOVED_PROXY_WARNING];
  return { projectId, hooks, services, status };
}
