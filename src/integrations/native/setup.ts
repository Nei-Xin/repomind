import { resolve } from "node:path";
import { RepositoryMemoryCore } from "../../core.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { initializeRepository } from "../../repository.js";
import { servicesStatus, startBridgeService, type ServiceManagerOptions } from "../../services/manager.js";
import { executeAgentProcess } from "../agent-host/process.js";
import { inspectNativeIntegration, installNativeIntegration } from "./install.js";
import type { NativeAgent } from "./client.js";

export interface NativeSetupOptions extends ServiceManagerOptions {
  agent: NativeAgent;
  repository: string;
  runnerExecutable?: string;
}
function installOptions(options: NativeSetupOptions) {
  return { ...options, extensionEntry: resolve(options.repoMindRoot, "dist/integrations/pi/extension.js") };
}
// Conservative minimums: these are the first versions validated by RepoMind.
export const NATIVE_MINIMUM_VERSIONS = { codex: "0.165.0", pi: "1.4.0", gemini: "0.66.0" } as const;
function supportedVersion(agent: NativeAgent, version: string | null): boolean {
  const match = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const minimum = NATIVE_MINIMUM_VERSIONS[agent].split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}
export async function nativeIntegrationStatus(options: NativeSetupOptions) {
  const root = locateGitRoot(options.repository);
  let projectId: string | null = null;
  try {
    const core = new RepositoryMemoryCore(root, options.dataDirectory ? { dataDirectory: options.dataDirectory } : {});
    projectId = core.context.marker.projectId;
    core.close();
  } catch { /* Report an uninitialized repository below. */ }
  const installation = inspectNativeIntegration(installOptions(options));
  const services = await servicesStatus(options);
  const executable = options.runnerExecutable ?? options.agent;
  const probe = await executeAgentProcess({ command: executable, args: ["--version"], cwd: root, env: process.env, timeoutMs: 5_000 });
  const version = probe.exitCode === 0 ? probe.stdout.trim() : null;
  const supported = supportedVersion(options.agent, version);
  const nextSteps = [
    ...(!projectId || !installation.configured || !services.bridge.healthy ? [`Run 'repomind ${options.agent} setup --repo ${JSON.stringify(root)}'.`] : []),
    ...(!supported ? [`Install ${options.agent} >= ${NATIVE_MINIMUM_VERSIONS[options.agent]} or pass --runner-executable.`] : []),
  ];
  return {
    ready: nextSteps.length === 0,
    repository: { root, initialized: projectId !== null, projectId },
    agent: { name: options.agent, executable, version, available: version !== null, supported, minimumVersion: NATIVE_MINIMUM_VERSIONS[options.agent] },
    installation, bridge: services.bridge,
    trust: { verified: false, instruction: options.agent === "codex"
      ? "Trust this project in Codex, then review and trust RepoMind hooks with /hooks. Re-review after setup changes the definitions."
      : options.agent === "gemini" ? "Trust this workspace in Gemini CLI and review RepoMind hooks with /hooks panel. Ensure hooksConfig.enabled is true and RepoMind hooks are not disabled in user/workspace settings."
      : "Trust the project-local Pi extension when prompted; restart Pi or run /reload after setup." },
    warnings: ["Readiness checks installation and Bridge health; client trust and actual model consumption require a native-client run.",
      ...(options.agent === "gemini" ? ["Gemini 0.66 omits successful shell exit codes; test commands without structured exits remain unverified. Cancellation cleanup runs on the next prompt/resume or best-effort SessionEnd. User/system hook settings and trust are not verified by this status check."] : []),
      ...(options.agent === "codex" ? ["Codex 0.165 Bash hooks expose stdout without exit status. Such commands remain activity, not verified-command evidence; unresolved verification makes a task partial."] : [])],
    nextSteps,
  };
}
export async function setupNativeIntegration(options: NativeSetupOptions) {
  const root = locateGitRoot(options.repository);
  const context = initializeRepository(root);
  const projectId = context.marker.projectId;
  context.database.close();
  const installation = installNativeIntegration(installOptions({ ...options, repository: root }));
  const services = await startBridgeService(options);
  return { projectId, installation, services, status: await nativeIntegrationStatus({ ...options, repository: root }) };
}
