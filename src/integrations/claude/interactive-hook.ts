import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export interface ClaudeInteractiveHookOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  timeoutMs?: number;
  input?: unknown;
  onWarning?: (message: string) => void;
}

interface BridgeStartResult {
  context?: string;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function transcriptStamp(payload: JsonObject): string {
  const path = stringValue(payload.transcript_path);
  if (!path) return "";
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return path;
  }
}

function eventId(payload: JsonObject, eventName: string): string {
  const native = stringValue(payload.hook_event_id)
    ?? stringValue(payload.tool_use_id)
    ?? stringValue(payload.tool_call_id);
  const identity = native ?? createHash("sha256")
    .update(`${stableJson(payload)}\0${transcriptStamp(payload)}`)
    .digest("hex")
    .slice(0, 32);
  return `claude-hook:${eventName}:${identity}`;
}

function bridgeBase(value: string | undefined): string {
  return (value ?? process.env.REPOMIND_BRIDGE_URL ?? "http://127.0.0.1:7345").replace(/\/$/u, "");
}

async function postBridge<T>(
  path: string,
  body: Record<string, unknown>,
  options: ClaudeInteractiveHookOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  const token = options.bridgeToken ?? process.env.REPOMIND_BRIDGE_TOKEN;
  try {
    const response = await fetch(`${bridgeBase(options.bridgeUrl)}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `Bridge returned HTTP ${response.status}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function hookInput(options: ClaudeInteractiveHookOptions): JsonObject {
  if (options.input !== undefined) return objectValue(options.input);
  const text = readFileSync(0, "utf8");
  return objectValue(JSON.parse(text) as unknown);
}

function activityBody(
  payload: JsonObject,
  repositoryPath: string,
  agentSessionId: string,
  eventName: string,
  type: "tool_call" | "tool_result" | "tool_failure" | "assistant_message" | "session_event",
  activityPayload: unknown,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: eventId(payload, eventName),
    agent: "claude",
    agentSessionId,
    repositoryPath,
    source: "claude-hook",
    type,
    timestamp: Date.now(),
    payload: activityPayload,
  };
}

function sessionId(payload: JsonObject): string {
  const value = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  if (!value) throw new Error("Claude hook input does not contain session_id");
  return value;
}

function repository(payload: JsonObject): string {
  return resolve(stringValue(payload.cwd) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

function promptText(payload: JsonObject): string {
  return stringValue(payload.prompt) ?? stringValue(payload.user_prompt) ?? "";
}

function assistantText(payload: JsonObject): string {
  return stringValue(payload.last_assistant_message)
    ?? stringValue(payload.assistant_message)
    ?? "";
}

export async function handleClaudeInteractiveHook(
  options: ClaudeInteractiveHookOptions = {},
): Promise<Record<string, unknown> | null> {
  const warn = options.onWarning ?? ((message: string) => console.error(`[RepoMind] ${message}`));
  try {
    const payload = hookInput(options);
    const hookEventName = stringValue(payload.hook_event_name);
    if (!hookEventName) throw new Error("Claude hook input does not contain hook_event_name");
    const agentSessionId = sessionId(payload);
    const repositoryPath = repository(payload);
    const common = { schemaVersion: 1, agent: "claude", agentSessionId, repositoryPath, timestamp: Date.now() };
    await postBridge("/v1/sessions/register", common, options);

    if (hookEventName === "UserPromptSubmit") {
      const task = promptText(payload);
      if (!task) return null;
      const result = await postBridge<BridgeStartResult>("/v1/tasks/start", {
        ...common,
        eventId: eventId(payload, hookEventName),
        task,
      }, options);
      if (!result.context?.trim()) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: result.context,
        },
      };
    }

    if (hookEventName === "PreToolUse") {
      await postBridge("/v1/activities", activityBody(
        payload,
        repositoryPath,
        agentSessionId,
        hookEventName,
        "tool_call",
        {
          toolName: payload.tool_name ?? null,
          toolInput: payload.tool_input ?? null,
          toolUseId: payload.tool_use_id ?? null,
        },
      ), options);
      return null;
    }

    if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
      await postBridge("/v1/activities", activityBody(
        payload,
        repositoryPath,
        agentSessionId,
        hookEventName,
        hookEventName === "PostToolUse" ? "tool_result" : "tool_failure",
        {
          toolName: payload.tool_name ?? null,
          toolInput: payload.tool_input ?? null,
          toolResponse: payload.tool_response ?? null,
          error: payload.error ?? null,
          toolUseId: payload.tool_use_id ?? null,
        },
      ), options);
      return null;
    }

    if (hookEventName === "Stop") {
      const summary = assistantText(payload);
      if (summary) {
        await postBridge("/v1/activities", activityBody(
          payload,
          repositoryPath,
          agentSessionId,
          `${hookEventName}:assistant`,
          "assistant_message",
          { text: summary },
        ), options);
      }
      await postBridge("/v1/tasks/finish", {
        ...common,
        eventId: eventId(payload, hookEventName),
        summary,
      }, options);
      return null;
    }

    if (hookEventName === "SessionEnd") {
      await postBridge("/v1/tasks/abort", {
        ...common,
        eventId: eventId(payload, hookEventName),
        reason: stringValue(payload.reason) ?? "Claude interactive session ended before an active task was finalized.",
      }, options);
      return null;
    }

    if (hookEventName === "SessionStart") {
      await postBridge("/v1/activities", activityBody(
        payload,
        repositoryPath,
        agentSessionId,
        hookEventName,
        "session_event",
        { kind: "session_start", source: payload.source ?? null },
      ), options);
    }
    return null;
  } catch (error) {
    warn(`interactive hook skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
