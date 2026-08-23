import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RepoMindError } from "../../errors.js";
import { locateGitRoot } from "../../git/git-inspector.js";

const MANAGED_MARKER = "// Managed by RepoMind. Re-run `repomind opencode setup` after moving or updating RepoMind.";

export interface OpenCodePluginInstallOptions {
  repository: string;
  pluginEntry: string;
}

export interface OpenCodePluginInstallResult {
  path: string;
  pluginEntry: string;
  installed: boolean;
  changed: boolean;
}

export interface OpenCodePluginInspectResult {
  path: string;
  pluginEntry: string;
  installed: boolean;
  managed: boolean;
  configured: boolean;
}

function pluginPath(repository: string): string {
  return join(locateGitRoot(repository), ".opencode", "plugins", "repomind.js");
}

function pluginSource(pluginEntry: string): string {
  const url = pathToFileURL(resolve(pluginEntry)).href;
  return `${MANAGED_MARKER}\nexport { RepoMindOpenCodePlugin } from ${JSON.stringify(url)};\n`;
}

export function inspectOpenCodeInteractivePlugin(
  options: OpenCodePluginInstallOptions,
): OpenCodePluginInspectResult {
  const path = pluginPath(options.repository);
  const expected = pluginSource(options.pluginEntry);
  if (!existsSync(path)) {
    return {
      path,
      pluginEntry: resolve(options.pluginEntry),
      installed: false,
      managed: false,
      configured: false,
    };
  }
  const current = readFileSync(path, "utf8");
  return {
    path,
    pluginEntry: resolve(options.pluginEntry),
    installed: true,
    managed: current.startsWith(MANAGED_MARKER),
    configured: current === expected,
  };
}

export function installOpenCodeInteractivePlugin(
  options: OpenCodePluginInstallOptions,
): OpenCodePluginInstallResult {
  const entry = resolve(options.pluginEntry);
  if (!existsSync(entry)) {
    throw new RepoMindError("INVALID_INPUT", `RepoMind OpenCode plugin entry is missing: ${entry}`);
  }
  const path = pluginPath(options.repository);
  const expected = pluginSource(entry);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current !== null && !current.startsWith(MANAGED_MARKER)) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `Refusing to replace an unmanaged OpenCode plugin: ${path}`,
    );
  }
  if (current === expected) {
    return { path, pluginEntry: entry, installed: true, changed: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.repomind-${process.pid}.tmp`;
  writeFileSync(temporary, expected, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
  return { path, pluginEntry: entry, installed: true, changed: true };
}
