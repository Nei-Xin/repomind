import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoMindError } from "../../errors.js";
import { executeAgentProcess } from "../agent-host/process.js";
import type {
  AgentHostAdapter,
  AgentHostRunRequest,
  AgentProcessExecutor,
  AgentProcessRequest,
} from "../agent-host/types.js";
import { analyzeClaudeEvents } from "./events.js";

const DEFAULT_NAME = "repomind-host";
const DEFAULT_DAILY_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell"] as const;
const CONTAINED_TOOLS = [
  "Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
] as const;
const WINDOWS_MAX_HOST_PROMPT_CHARS = 28_000;
const WINDOWS_MAX_COMMAND_LINE_CHARS = 32_767;

export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";

export interface ClaudeHostAdapterOptions {
  executable?: string;
  execute?: AgentProcessExecutor;
  name?: string;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  maxBudgetUsd?: number;
  /** Asserted only by a Host that created and owns an isolated disposable checkout. */
  trustedIsolatedCheckout?: boolean;
}

function windowsQuotedArgumentChars(argument: string): number {
  if (!argument.length) return 2;
  if (!/[\t "]/u.test(argument)) return argument.length;
  let chars = 1;
  let backslashes = 0;
  for (let index = 0; index < argument.length; index++) {
    const value = argument[index]!;
    if (value === "\\") {
      backslashes += 1;
    } else if (value === "\"") {
      chars += backslashes * 2 + 2;
      backslashes = 0;
    } else {
      chars += backslashes + 1;
      backslashes = 0;
    }
  }
  return chars + backslashes * 2 + 1;
}

function windowsCommandLineChars(command: string, args: readonly string[]): number {
  const values = [command, ...args];
  return values.reduce((sum, value) => sum + windowsQuotedArgumentChars(value), values.length - 1) + 1;
}

export function resolveClaudeExecutable(executable = "claude"): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return resolve(executable);
  if (executable !== "claude" || process.platform !== "win32") return executable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const native = join(directory, "claude.exe");
    if (existsSync(native)) return native;
  }
  return "claude.exe";
}

function validateOptions(options: ClaudeHostAdapterOptions): void {
  if (options.name !== undefined && !options.name.trim()) {
    throw new RepoMindError("INVALID_INPUT", "Claude session name cannot be empty");
  }
  if (options.allowedTools?.some((tool) => !tool.trim())) {
    throw new RepoMindError("INVALID_INPUT", "Claude allowed tool names cannot be empty");
  }
  if (options.maxBudgetUsd !== undefined && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0)) {
    throw new RepoMindError("INVALID_INPUT", "Claude max budget must be a positive number");
  }
  if (options.permissionMode === "bypassPermissions" && options.trustedIsolatedCheckout !== true) {
    throw new RepoMindError(
      "INVALID_INPUT",
      "Claude bypassPermissions requires a trusted isolated checkout owned by the Host",
    );
  }
}

function invocation(
  executable: string,
  request: AgentHostRunRequest,
  options: ClaudeHostAdapterOptions,
): AgentProcessRequest {
  validateOptions(options);
  const permissionMode = options.permissionMode
    ?? (options.trustedIsolatedCheckout === true ? "bypassPermissions" : "dontAsk");
  const allowedTools = options.allowedTools
    ?? (permissionMode === "bypassPermissions" ? [] : [...DEFAULT_DAILY_ALLOWED_TOOLS]);
  const checkoutContainment = options.trustedIsolatedCheckout === true;
  const args = [
    "--print",
    "--name", options.name?.trim() ?? DEFAULT_NAME,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", permissionMode,
  ];
  if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  args.push("--no-session-persistence", "--prompt-suggestions", "false");
  if (checkoutContainment) {
    const hookPath = fileURLToPath(new URL("./containment-hook.js", import.meta.url));
    const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`;
    args.push(
      "--tools", CONTAINED_TOOLS.join(","),
      "--settings", JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell",
            hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
          }],
        },
      }),
      "--include-hook-events",
    );
  }
  if (allowedTools.length) args.push("--allowedTools", allowedTools.map((tool) => tool.trim()).join(","));
  if (options.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(options.maxBudgetUsd));
  if (request.model) args.push("--model", request.model);
  args.push(request.prompt);

  if (process.platform === "win32" && request.prompt.length > WINDOWS_MAX_HOST_PROMPT_CHARS) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `Rendered Host prompt is too large for a reliable Windows process launch (${request.prompt.length} characters); shorten --task or reduce --context-budget`,
    );
  }
  const commandLineChars = windowsCommandLineChars(executable, args);
  if (process.platform === "win32" && commandLineChars > WINDOWS_MAX_COMMAND_LINE_CHARS) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `Rendered Host prompt is too large for a reliable Windows process launch (${commandLineChars} quoted command-line characters); shorten --task or reduce --context-budget`,
    );
  }
  return {
    command: executable,
    args,
    cwd: request.repository,
    env: checkoutContainment
      ? { ...process.env, REPOMIND_AGENT_ROOT: resolve(request.repository) }
      : process.env,
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onStdout ? { onStdout: request.onStdout } : {}),
    ...(request.onStderr ? { onStderr: request.onStderr } : {}),
  };
}

export function createClaudeHostAdapter(
  options: ClaudeHostAdapterOptions = {},
): AgentHostAdapter<"claude"> {
  validateOptions(options);
  const executable = resolveClaudeExecutable(options.executable);
  const execute = options.execute ?? executeAgentProcess;
  const validate = (request: AgentHostRunRequest): void => { invocation(executable, request, options); };
  return {
    id: "claude",
    displayName: "Claude Code",
    executable,
    validate,
    async run(request) {
      const processResult = await execute(invocation(executable, request, options));
      const analysis = analyzeClaudeEvents(
        processResult.stdout,
        `Claude Code ended with exit code ${processResult.exitCode ?? "unknown"}${processResult.signal ? ` and signal ${processResult.signal}` : ""}.`,
      );
      return { process: processResult, outcome: analysis.outcome, events: analysis.metrics };
    },
    async version(cwd) {
      const result = await execute({
        command: executable,
        args: ["--version"],
        cwd,
        env: process.env,
        timeoutMs: 30_000,
      });
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },
  };
}
