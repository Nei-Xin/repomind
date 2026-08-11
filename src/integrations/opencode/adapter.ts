import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { RepoMindError } from "../../errors.js";
import { analyzeAgentEvents, parseAgentEvents } from "../../eval/agent/events.js";
import { executeAgentProcess } from "../agent-host/process.js";
import type {
  AgentHostAdapter,
  AgentHostRunRequest,
  AgentProcessExecutor,
  AgentProcessRequest,
} from "../agent-host/types.js";
import { analyzeOpenCodeOutcome } from "./lifecycle.js";

const HOST_AGENT = "repomind-host";
const RESUME_PROMPT = "Continue the interrupted task from the current repository state. Verify the existing changes and finish with a concise final summary.";
const WINDOWS_MAX_HOST_PROMPT_CHARS = 28_000;
const WINDOWS_MAX_COMMAND_LINE_CHARS = 32_767;

export interface OpenCodeHostAdapterOptions {
  executable?: string;
  execute?: AgentProcessExecutor;
}

function windowsQuotedArgumentChars(argument: string): number {
  if (!argument.length) return 2;
  if (!/[\t "]/u.test(argument)) return argument.length;
  let chars = 1;
  let backslashes = 0;
  for (let index = 0; index < argument.length; index++) {
    const value = argument[index]!;
    if (value === "\\") {
      backslashes++;
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

export function resolveOpenCodeExecutable(executable = "opencode"): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return resolve(executable);
  if (executable !== "opencode") return executable;
  if (process.platform !== "win32") return executable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const native = join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(native)) return native;
  }
  return `${executable}.exe`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hostManagedOpenCodeConfig(existing: string | undefined): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      base = objectValue(JSON.parse(existing) as unknown);
    } catch (error) {
      throw new RepoMindError("INVALID_INPUT", "OPENCODE_CONFIG_CONTENT is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const agents = objectValue(base.agent);
  const mcp = objectValue(base.mcp);
  const repoMindMcp = objectValue(mcp.repomind);
  return JSON.stringify({
    ...base,
    agent: {
      ...agents,
      [HOST_AGENT]: {
        description: "OpenCode Agent with a RepoMind host-managed lifecycle",
        mode: "primary",
        prompt: "Complete the repository task directly, verify the result, and provide a concise final summary. RepoMind lifecycle is managed by the host; do not call RepoMind session or memory tools.",
        tools: { task: false, call_omo_agent: false, teammate: false, background_output: false, background_cancel: false },
        permission: {
          task: "deny",
          call_omo_agent: "deny",
          teammate: "deny",
          "task_*": "deny",
          external_directory: "deny",
        },
      },
    },
    mcp: { ...mcp, repomind: { ...repoMindMcp, enabled: false } },
  });
}

function invocation(
  executable: string,
  request: AgentHostRunRequest,
  continuationToken?: string,
): AgentProcessRequest {
  const args = ["run", "--pure", "--format", "json", "--auto", "--agent", HOST_AGENT, "--dir", request.repository];
  if (request.model) args.push("--model", request.model);
  if (continuationToken) args.push("--session", continuationToken);
  const prompt = continuationToken ? RESUME_PROMPT : request.prompt;
  args.push(prompt);
  if (process.platform === "win32" && prompt.length > WINDOWS_MAX_HOST_PROMPT_CHARS) {
    throw new RepoMindError(
      "INVALID_INPUT",
      `Rendered Host prompt is too large for a reliable Windows process launch (${prompt.length} characters); shorten --task or reduce --context-budget`,
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
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: hostManagedOpenCodeConfig(process.env.OPENCODE_CONFIG_CONTENT),
    },
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onStdout ? { onStdout: request.onStdout } : {}),
    ...(request.onStderr ? { onStderr: request.onStderr } : {}),
  };
}

export function extractOpenCodeSessionId(jsonl: string): string | undefined {
  const sessionIds = new Set<string>();
  for (const event of parseAgentEvents(jsonl).events) {
    if (typeof event.sessionID === "string" && event.sessionID.trim()) {
      sessionIds.add(event.sessionID.trim());
    }
  }
  return sessionIds.size === 1 ? [...sessionIds][0] : undefined;
}

export function createOpenCodeHostAdapter(
  options: OpenCodeHostAdapterOptions = {},
): AgentHostAdapter<"opencode"> {
  const executable = resolveOpenCodeExecutable(options.executable);
  const execute = options.execute ?? executeAgentProcess;
  const validate = (request: AgentHostRunRequest): void => { invocation(executable, request); };
  const executeRequest = async (
    request: AgentHostRunRequest,
    continuationToken?: string,
  ) => {
    const result = await execute(invocation(executable, request, continuationToken));
    const observedSessionId = extractOpenCodeSessionId(result.stdout);
    const resumableSessionId = continuationToken && observedSessionId !== continuationToken
      ? undefined
      : observedSessionId;
    return {
      process: result,
      outcome: analyzeOpenCodeOutcome(
        result.stdout,
        `OpenCode ended with exit code ${result.exitCode ?? "unknown"}${result.signal ? ` and signal ${result.signal}` : ""}.`,
      ),
      events: analyzeAgentEvents(result.stdout),
      ...(resumableSessionId ? { continuationToken: resumableSessionId } : {}),
    };
  };
  return {
    id: "opencode",
    displayName: "OpenCode",
    executable,
    validate,
    run: (request) => executeRequest(request),
    resume: (request, continuationToken) => executeRequest(request, continuationToken),
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
