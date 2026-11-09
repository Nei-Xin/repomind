import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { locateGitRoot } from "../../git/git-inspector.js";
import { RepositoryMemoryCore } from "../../core.js";
import { initializeRepository } from "../../repository.js";
import { RepoMindError } from "../../errors.js";
import { servicesStatus, startBridgeService, type ServiceManagerOptions } from "../../services/manager.js";
import { executeAgentProcess } from "../agent-host/process.js";

export const DSH_VALIDATED_VERSION = "0.2.2-rc.1";
const MARKER = "# Managed by RepoMind: DSH repository memory overlay.";
export interface DshInstallOptions { repository: string; pluginEntry: string; bridgeUrl?: string }
export interface DshSetupOptions extends ServiceManagerOptions { repository: string; runnerExecutable?: string }

function expected(options: DshInstallOptions) {
  const root = locateGitRoot(options.repository);
  const path = join(root, ".repomind", "dsh", "cordis.patch.yml");
  // JSON strings are YAML-compatible quoted scalars (including Windows paths).
  const content = `${MARKER}\n# Load with: dsh web --patch <this-file>\n- insert:\n`
    + `    - id: repomind\n      name: ${JSON.stringify(pathToFileURL(resolve(options.pluginEntry)).href)}\n`
    + `      config:\n        repository: ${JSON.stringify(root)}\n`
    + (options.bridgeUrl ? `        bridgeUrl: ${JSON.stringify(options.bridgeUrl)}\n` : "");
  return { path, content };
}
export function inspectDshPlugin(options: DshInstallOptions) {
  const { path, content } = expected(options);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  return { path, installed: current !== null, managed: current?.startsWith(MARKER) ?? false,
    configured: current === content && existsSync(options.pluginEntry), pluginEntry: resolve(options.pluginEntry) };
}
export function installDshPlugin(options: DshInstallOptions) {
  if (!existsSync(options.pluginEntry)) throw new RepoMindError("INVALID_INPUT", `RepoMind DSH plugin entry is missing: ${options.pluginEntry}`);
  const current = inspectDshPlugin(options);
  if (current.installed && !current.managed) throw new RepoMindError("INVALID_INPUT", `Refusing to replace unmanaged DSH overlay: ${current.path}`);
  const { path, content } = expected(options);
  if (!current.configured) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  }
  return { ...inspectDshPlugin(options), changed: !current.configured };
}
function installationOptions(options: DshSetupOptions): DshInstallOptions {
  return { repository: options.repository, pluginEntry: resolve(options.repoMindRoot, "dist/integrations/dsh/plugin.js"),
    ...(options.bridgePort === undefined ? {} : { bridgeUrl: `http://127.0.0.1:${options.bridgePort}` }) };
}
export async function dshIntegrationStatus(options: DshSetupOptions) {
  const root = locateGitRoot(options.repository);
  let projectId: string | null = null;
  try {
    const core = new RepositoryMemoryCore(root, options.dataDirectory ? { dataDirectory: options.dataDirectory } : {});
    projectId = core.context.marker.projectId;
    core.close();
  } catch { /* Report an uninitialized repository. */ }
  const installation = inspectDshPlugin(installationOptions(options));
  const services = await servicesStatus(options);
  const executable = options.runnerExecutable ?? "dsh";
  const probe = await executeAgentProcess({ command: executable, args: ["--version"], cwd: root, env: process.env, timeoutMs: 10_000 });
  const version = probe.exitCode === 0 ? probe.stdout.trim() : null;
  // DSH preview releases may break plugins. Do not claim all future semvers work.
  const validated = version === DSH_VALIDATED_VERSION;
  const nextSteps = [
    ...(!projectId || !installation.configured || !services.bridge.healthy ? [`Run 'repomind dsh setup --repo ${JSON.stringify(root)}'.`] : []),
    ...(!validated ? [`Install @deepseek-ai/dsh@${DSH_VALIDATED_VERSION} with Node >=24.9; use --runner-executable if it is not on PATH.`] : []),
  ];
  return {
    ready: nextSteps.length === 0,
    repository: { root, initialized: projectId !== null, projectId },
    agent: { name: "dsh", executable, version, validated, validatedVersion: DSH_VALIDATED_VERSION },
    installation, bridge: services.bridge,
    launch: { command: executable, args: ["web", "--patch", installation.path], cwd: root },
    warnings: ["Load the generated overlay with --patch; DSH does not automatically load project-local plugins.",
      "Readiness checks files, version and Bridge health; actual plugin loading and model consumption require a DSH run.",
      "Only root user turns in this Git checkout are recorded. Subagent activity and completed background jobs are not promoted to verified command evidence."],
    nextSteps,
  };
}
export async function setupDshIntegration(options: DshSetupOptions) {
  const root = locateGitRoot(options.repository);
  const context = initializeRepository(root);
  const projectId = context.marker.projectId;
  context.database.close();
  const installation = installDshPlugin(installationOptions({ ...options, repository: root }));
  const services = await startBridgeService(options);
  return { projectId, installation, services, status: await dshIntegrationStatus({ ...options, repository: root }) };
}
