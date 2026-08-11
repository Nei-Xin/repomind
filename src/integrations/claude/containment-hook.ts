import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

export interface ClaudeContainmentDecision {
  allowed: boolean;
  reason: string | null;
}

const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
};

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const INDIRECT_SHELL = /(?:^|[;&|]\s*|\s)(?:bash|cmd(?:\.exe)?|powershell|pwsh|sh|wsl)(?:\.exe)?\s+(?:-c|\/c|-[Cc]ommand)\b|(?:^|[;&|]\s*|\s)(?:node|python|python3)(?:\.exe)?\s+(?:-e|--eval|-c)\b/iu;
const PARENT_TRAVERSAL = /(?:^|[\\/\s"'=,(])\.\.(?:[\\/\s"'),;|&]|$)/u;
const PATH_ENV_EXPANSION = /%\w+%|\$(?:env:)?(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)|~[\\/]/iu;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function canonicalRoot(root: string): string {
  const resolved = resolve(root);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalCandidate(candidate: string): string {
  if (existsSync(candidate)) return realpathSync.native(candidate);
  const missing: string[] = [];
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return candidate;
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  let canonical = realpathSync.native(ancestor);
  for (const segment of missing) canonical = resolve(canonical, segment);
  return canonical;
}

export function pathWithinCheckout(root: string, value: string): boolean {
  if (!value.trim() || value.includes("\0")) return false;
  const lexicalRoot = resolve(root);
  const base = canonicalRoot(root);
  const lexical = resolve(lexicalRoot, value);
  if (!inside(lexicalRoot, lexical)) return false;
  try {
    const stat = lstatSync(base);
    if (!stat.isDirectory()) return false;
    return inside(base, canonicalCandidate(lexical));
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const trimmed = value.replace(/^[,=]+|[,]+$/gu, "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shellTokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()[\]]+/gu)?.map(unquote) ?? [];
}

function shellDecision(root: string, command: string): ClaudeContainmentDecision {
  if (!command.trim()) return { allowed: false, reason: "Shell command is empty." };
  if (PARENT_TRAVERSAL.test(command)) {
    return { allowed: false, reason: "Shell command contains parent-directory traversal." };
  }
  if (PATH_ENV_EXPANSION.test(command)) {
    return { allowed: false, reason: "Shell command expands a user or home path outside the checkout." };
  }
  if (INDIRECT_SHELL.test(command)) {
    return { allowed: false, reason: "Nested command interpreters are disabled by checkout containment." };
  }
  for (const rawToken of shellTokens(command)) {
    const token = rawToken.includes("=") ? rawToken.slice(rawToken.indexOf("=") + 1) : rawToken;
    if ((isAbsolute(token) || /^[A-Za-z]:[\\/]/u.test(token) || token.startsWith("\\\\"))
      && !pathWithinCheckout(root, token)) {
      return { allowed: false, reason: `Shell path is outside the checkout: ${token}` };
    }
  }
  return { allowed: true, reason: null };
}

export function evaluateClaudeContainment(
  root: string,
  event: unknown,
): ClaudeContainmentDecision {
  const payload = objectValue(event);
  if (payload.hook_event_name !== "PreToolUse") {
    return { allowed: false, reason: "Unexpected Claude hook event." };
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = objectValue(payload.tool_input);
  if (SHELL_TOOLS.has(toolName)) {
    return shellDecision(root, typeof input.command === "string" ? input.command : "");
  }
  const fields = PATH_FIELDS[toolName];
  if (!fields) return { allowed: true, reason: null };
  for (const field of fields) {
    const value = input[field];
    if (value === undefined && (toolName === "Glob" || toolName === "Grep")) continue;
    if (typeof value !== "string" || !pathWithinCheckout(root, value)) {
      return { allowed: false, reason: `${toolName}.${field} is outside the checkout.` };
    }
  }
  return { allowed: true, reason: null };
}

function runHook(): void {
  const root = process.env.REPOMIND_AGENT_ROOT;
  if (!root) {
    console.error("RepoMind checkout containment is missing REPOMIND_AGENT_ROOT.");
    process.exitCode = 2;
    return;
  }
  try {
    const event = JSON.parse(readFileSync(0, "utf8")) as unknown;
    const decision = evaluateClaudeContainment(root, event);
    if (!decision.allowed) {
      console.error(`RepoMind checkout containment denied the tool call: ${decision.reason ?? "unknown reason"}`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`RepoMind checkout containment failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) runHook();
