import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RepositoryMemoryCore } from "../../core.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { initializeRepository } from "../../repository.js";
import {
  servicesStatus,
  startBridgeService,
  type ServiceManagerOptions,
  type ServicesResult,
} from "../../services/manager.js";
import { createOpenCodeHostAdapter } from "./adapter.js";
import {
  inspectOpenCodeInteractivePlugin,
  installOpenCodeInteractivePlugin,
  type OpenCodePluginInspectResult,
  type OpenCodePluginInstallResult,
} from "./plugin-installer.js";

export interface OpenCodeInteractiveOptions extends ServiceManagerOptions {
  repository: string;
  runnerExecutable?: string;
}

export interface OpenCodeInteractiveStatus {
  ready: boolean;
  repository: { root: string; initialized: boolean; projectId: string | null };
  opencode: { executable: string; available: boolean; version: string | null };
  plugin: OpenCodePluginInspectResult;
  bridge: ServicesResult["bridge"];
  warnings: string[];
  nextSteps: string[];
}

function pluginEntry(options: OpenCodeInteractiveOptions): string {
  return resolve(options.repoMindRoot, "dist", "integrations", "opencode", "interactive-plugin.js");
}

function hasEnabledRepoMindMcp(root: string): boolean {
  const path = join(root, "opencode.json");
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const mcp = config.mcp && typeof config.mcp === "object" ? config.mcp as Record<string, unknown> : {};
    const repomind = mcp.repomind && typeof mcp.repomind === "object"
      ? mcp.repomind as Record<string, unknown>
      : null;
    return repomind !== null && repomind.enabled !== false;
  } catch {
    return false;
  }
}

export async function openCodeInteractiveStatus(
  options: OpenCodeInteractiveOptions,
): Promise<OpenCodeInteractiveStatus> {
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
  const plugin = inspectOpenCodeInteractivePlugin({ repository: root, pluginEntry: pluginEntry(options) });
  const services = await servicesStatus(options);
  const adapter = createOpenCodeHostAdapter({
    ...(options.runnerExecutable ? { executable: options.runnerExecutable } : {}),
  });
  const version = await adapter.version(root);
  const warnings = hasEnabledRepoMindMcp(root)
    ? ["RepoMind MCP is enabled in opencode.json; disable it to avoid a second Agent-managed lifecycle."]
    : [];
  const nextSteps = [
    ...(projectId ? [] : [`Run 'repomind opencode setup --repo ${JSON.stringify(root)}'.`]),
    ...(plugin.configured
      ? []
      : [`Run 'repomind opencode setup --repo ${JSON.stringify(root)}' to install or repair the project plugin.`]),
    ...(services.bridge.healthy ? [] : ["Run 'repomind opencode setup' or start the RepoMind Bridge."]),
    ...(version ? [] : ["Install OpenCode or add the opencode executable to PATH."]),
  ];
  const uniqueNextSteps = [...new Set(nextSteps)];
  return {
    ready: uniqueNextSteps.length === 0,
    repository: { root, initialized: projectId !== null, projectId },
    opencode: { executable: adapter.executable, available: version !== null, version },
    plugin,
    bridge: services.bridge,
    warnings,
    nextSteps: uniqueNextSteps,
  };
}

export async function setupOpenCodeInteractive(options: OpenCodeInteractiveOptions): Promise<{
  projectId: string;
  plugin: OpenCodePluginInstallResult;
  services: ServicesResult;
  status: OpenCodeInteractiveStatus;
}> {
  const root = resolve(locateGitRoot(options.repository));
  const context = initializeRepository(root);
  const projectId = context.marker.projectId;
  context.database.close();
  const plugin = installOpenCodeInteractivePlugin({ repository: root, pluginEntry: pluginEntry(options) });
  const services = await startBridgeService(options);
  const status = await openCodeInteractiveStatus({ ...options, repository: root });
  return { projectId, plugin, services, status };
}
