import { resolve } from "node:path";
import { RepositoryMemoryCore } from "../../core.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { initializeRepository } from "../../repository.js";
import {
  servicesStatus,
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

export const DEFAULT_CLAUDE_PROXY_URL = "http://127.0.0.1:8096/claude-code/default";

export interface ClaudeInteractiveOptions extends ServiceManagerOptions {
  repository: string;
  proxyUrl?: string;
  runnerExecutable?: string;
}

export interface ClaudeInteractiveStatus {
  ready: boolean;
  repository: { root: string; initialized: boolean; projectId: string | null };
  claude: { executable: string; available: boolean; version: string | null };
  hooks: InspectClaudeHooksResult;
  services: ServicesResult;
  nextSteps: string[];
}

function hookOptions(options: ClaudeInteractiveOptions) {
  return {
    repository: options.repository,
    cliEntry: options.cliEntry,
    bridgeUrl: "http://127.0.0.1:7345",
    proxyUrl: options.proxyUrl ?? DEFAULT_CLAUDE_PROXY_URL,
  };
}

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
  const nextSteps = [
    ...(projectId ? [] : [`Run 'repomind claude setup --repo ${JSON.stringify(root)}'.`]),
    ...(hooks.installed === hooks.expected && hooks.proxyEnvironment.configured
      ? []
      : [`Run 'repomind claude setup --repo ${JSON.stringify(root)}' to repair Claude hooks and proxy routing.`]),
    ...(services.bridge.healthy && services.memoryProxy.healthy ? [] : ["Run 'repomind services start'."]),
    ...(version ? [] : ["Install Claude Code or add the claude executable to PATH."]),
  ];
  const uniqueNextSteps = [...new Set(nextSteps)];
  return {
    ready: uniqueNextSteps.length === 0,
    repository: { root, initialized: projectId !== null, projectId },
    claude: { executable: adapter.executable, available: version !== null, version },
    hooks,
    services,
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
  const services = await startServices(options);
  const status = await claudeInteractiveStatus({ ...options, repository: root });
  return { projectId, hooks, services, status };
}
