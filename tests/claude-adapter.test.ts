import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import { analyzeClaudeEvents } from "../src/integrations/claude/events.js";
import {
  createAgentHostAdapter,
  isRegisteredAgentHostId,
  REGISTERED_AGENT_HOST_IDS,
} from "../src/integrations/agent-host/registry.js";
import type {
  AgentProcessExecutor,
  AgentProcessRequest,
  AgentProcessResult,
} from "../src/integrations/agent-host/types.js";

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n")}\n`;
}

function processResult(stdout: string, exitCode = 0): AgentProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 25,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function successResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    api_error_status: null,
    num_turns: 3,
    result: "Implemented and verified the requested change.",
    usage: {
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 4,
    },
    modelUsage: {
      "gpt-5.6-luna": {
        inputTokens: 999,
        outputTokens: 999,
      },
    },
    ...overrides,
  };
}

function toolResult(
  toolUseId: string,
  content: string,
  options: { isError?: boolean; metadata?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        ...(options.isError === undefined ? {} : { is_error: options.isError }),
      }],
    },
    ...(options.metadata ? { tool_use_result: options.metadata } : {}),
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe("Claude Code host adapter", () => {
  it("uses the daily non-interactive permission policy and normalizes cumulative telemetry", async () => {
    const stdout = jsonl(
      { type: "system", subtype: "init", model: "gpt-5.6-luna" },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 5_000, output_tokens: 5_000 } },
        },
      },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 2_000, output_tokens: 2_000 },
          content: [
            { type: "text", text: "Intermediate response" },
            { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/main.ts" } },
            { type: "tool_use", id: "read-2", name: "Read", input: { file_path: "SRC/Main.ts" } },
            {
              type: "tool_use",
              id: "memory-1",
              name: "mcp__repomind__repo_session_start",
              input: { task: "test" },
            },
          ],
        },
      },
      toolResult("bash-1", "tests passed", {
        isError: false,
        metadata: { stdout: "tests passed", stderr: "", interrupted: false },
      }),
      toolResult("read-1", "first read"),
      toolResult("read-2", "second read"),
      toolResult("memory-1", JSON.stringify({ memories: [{ id: "m1" }, { id: "m2" }] })),
      successResult(),
    );
    const requests: AgentProcessRequest[] = [];
    const execute: AgentProcessExecutor = async (request) => {
      requests.push(request);
      return request.args[0] === "--version"
        ? processResult("2.1.226 (Claude Code)\n")
        : processResult(stdout);
    };
    const adapter = createClaudeHostAdapter({ executable: "claude-test", execute });
    const result = await adapter.run({
      repository: "C:\\fixture\\checkout",
      prompt: "Implement the fixture task",
      model: "gpt-5.6-luna",
      timeoutMs: 60_000,
    });

    expect(adapter.id).toBe("claude");
    expect(adapter.displayName).toBe("Claude Code");
    expect(requests).toHaveLength(1);
    const invocation = requests[0]!;
    expect(invocation.command).toBe("claude-test");
    expect(invocation.cwd).toBe("C:\\fixture\\checkout");
    expect(invocation.args).toContain("--print");
    expect(invocation.args).toContain("--verbose");
    expect(invocation.args).toContain("--no-session-persistence");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(invocation.args, "--name")).toBe("repomind-host");
    expect(flagValue(invocation.args, "--output-format")).toBe("stream-json");
    expect(flagValue(invocation.args, "--permission-mode")).toBe("dontAsk");
    expect(flagValue(invocation.args, "--allowedTools")).toBe("Read,Glob,Grep,Edit,Write,Bash,PowerShell");
    expect(flagValue(invocation.args, "--prompt-suggestions")).toBe("false");
    expect(flagValue(invocation.args, "--model")).toBe("gpt-5.6-luna");
    expect(invocation.args.at(-1)).toBe("Implement the fixture task");

    expect(result.outcome.summary).toBe("Implemented and verified the requested change.");
    expect(result.outcome.commands).toEqual([{
      command: "npm test",
      exitCode: 0,
      exitCodeKnown: true,
      isTest: true,
      summary: "tests passed",
    }]);
    expect(result.outcome.trace).toMatchObject({
      malformedLines: 0,
      explicitErrors: 0,
      unknownCommandResults: 0,
      terminal: "clean-stop",
    });
    expect(result.events).toEqual({
      turns: 3,
      tokens: { input: 11, output: 5, reasoning: 0, cacheRead: 2, cacheWrite: 4 },
      toolCalls: { Bash: 1, mcp__repomind__repo_session_start: 1, Read: 2 },
      failedTools: 0,
      failedCommands: 0,
      fileReads: 2,
      failedFileReads: 0,
      repeatedFileReads: 1,
      repoMindCalls: 1,
      retrievedMemories: 2,
    });

    await expect(adapter.version("C:\\fixture\\checkout")).resolves.toBe("2.1.226 (Claude Code)");
    expect(requests[1]?.args).toEqual(["--version"]);
  });

  it("allows bypassPermissions only for a Host-asserted trusted isolated checkout", async () => {
    const repository = resolve("fixture", "isolated-checkout");
    const requests: AgentProcessRequest[] = [];
    const execute: AgentProcessExecutor = async (request) => {
      requests.push(request);
      return processResult(jsonl(successResult()));
    };
    expect(() => createClaudeHostAdapter({
      executable: "claude-test",
      execute,
      permissionMode: "bypassPermissions",
    })).toThrow(/trusted isolated checkout/u);

    const adapter = createAgentHostAdapter("claude", {
      executable: "claude-test",
      execute,
      trustedIsolatedCheckout: true,
    });
    await adapter.run({
      repository,
      prompt: "Implement the isolated fixture task",
      model: "gpt-5.6-luna",
      timeoutMs: 60_000,
    });
    expect(flagValue(requests[0]!.args, "--permission-mode")).toBe("bypassPermissions");
    expect(requests[0]!.args).toContain("--dangerously-skip-permissions");
    expect(requests[0]!.args).not.toContain("--allowedTools");
    expect(flagValue(requests[0]!.args, "--tools")).toContain("Read,Glob,Grep,Edit,Write,Bash,PowerShell");
    expect(requests[0]!.args).toContain("--include-hook-events");
    expect(requests[0]!.env.REPOMIND_AGENT_ROOT).toBe(repository);
    const settings = JSON.parse(flagValue(requests[0]!.args, "--settings") ?? "{}") as {
      hooks?: { PreToolUse?: Array<{ matcher?: string }> };
    };
    expect(settings.hooks?.PreToolUse?.[0]?.matcher).toContain("Read|Glob|Grep");
  });

  it("registers both supported Host adapters and rejects unknown runners", () => {
    expect(REGISTERED_AGENT_HOST_IDS).toEqual(["opencode", "claude"]);
    expect(isRegisteredAgentHostId("opencode")).toBe(true);
    expect(isRegisteredAgentHostId("claude")).toBe(true);
    expect(isRegisteredAgentHostId("unknown")).toBe(false);
    expect(createAgentHostAdapter("opencode", { executable: "opencode-test" }).id).toBe("opencode");
    expect(createAgentHostAdapter("claude", { executable: "claude-test" }).id).toBe("claude");
    expect(() => createAgentHostAdapter("unknown")).toThrow(/Unsupported Agent host adapter unknown/u);
  });

  it("requires a unique Bash or PowerShell tool result before trusting command status", () => {
    const analysis = analyzeClaudeEvents(jsonl(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "failed", name: "Bash", input: { command: "npm test" } },
            { type: "tool_use", id: "missing", name: "PowerShell", input: { command: "Get-Content README.md" } },
            { type: "tool_use", id: "duplicate", name: "Bash", input: { command: "npm run lint" } },
            { type: "tool_use", id: "contradictory", name: "Bash", input: { command: "echo contradictory" } },
          ],
        },
      },
      toolResult("failed", "Exit code 7\ntests failed", { isError: true }),
      toolResult("duplicate", "lint passed"),
      toolResult("duplicate", "duplicate result"),
      toolResult("contradictory", "Exit code 0", { isError: true }),
      successResult(),
    ), "fallback");

    expect(analysis.outcome.commands.map(({ command, exitCode, exitCodeKnown }) => ({
      command,
      exitCode,
      exitCodeKnown,
    }))).toEqual([
      { command: "npm test", exitCode: 7, exitCodeKnown: true },
      { command: "Get-Content README.md", exitCode: 1, exitCodeKnown: false },
      { command: "npm run lint", exitCode: 1, exitCodeKnown: false },
      { command: "echo contradictory", exitCode: 1, exitCodeKnown: false },
    ]);
    expect(analysis.outcome.trace).toMatchObject({
      unknownCommandResults: 3,
      terminal: "clean-stop",
    });
    expect(analysis.metrics.failedTools).toBe(2);
    expect(analysis.metrics.failedCommands).toBe(4);
  });

  it("treats an API-error result as explicit failure even when subtype is success", () => {
    const analysis = analyzeClaudeEvents(jsonl(
      "not-json",
      {
        type: "assistant",
        is_api_error_message: true,
        error: "unknown",
        message: { content: [{ type: "text", text: "API Error: 400 synthetic failure" }] },
      },
      successResult({
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        result: "API Error: 400 synthetic failure",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ), "fallback");

    expect(analysis.outcome.summary).toBe("API Error: 400 synthetic failure");
    expect(analysis.outcome.trace).toMatchObject({
      malformedLines: 1,
      explicitErrors: 2,
      terminal: "explicit-error",
    });
    expect(analysis.metrics.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("requires both is_error=false and terminal_reason=completed for a clean stop", () => {
    const wrongReason = analyzeClaudeEvents(jsonl(successResult({
      is_error: false,
      terminal_reason: "api_error",
      api_error_status: null,
    })), "fallback");
    const missingResult = analyzeClaudeEvents(jsonl({
      type: "assistant",
      message: { content: [{ type: "text", text: "unfinished" }] },
    }), "fallback");

    expect(wrongReason.outcome.trace.terminal).toBe("explicit-error");
    expect(missingResult.outcome.trace.terminal).toBe("incomplete");
    expect(missingResult.outcome.summary).toBe("unfinished");
  });
});
