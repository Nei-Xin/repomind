import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeUnavailableMessage, type BridgeClientOptions } from "../../bridge/client.js";
import { nativeClient, nativeEventId, objectValue, stringValue } from "../native/client.js";

export interface CodexHookOptions extends BridgeClientOptions {
  input?: unknown;
  onWarning?: (message: string) => void;
}

/** Hooks carry native turn IDs; never read Codex's unstable transcript format. */
export async function handleCodexInteractiveHook(options: CodexHookOptions = {}): Promise<Record<string, unknown>> {
  try {
    const payload = objectValue(options.input ?? JSON.parse(readFileSync(0, "utf8")));
    const event = stringValue(payload.hook_event_name);
    const session = stringValue(payload.session_id);
    const cwd = stringValue(payload.cwd);
    if (!event || !session || !cwd) throw new Error("Codex hook requires hook_event_name, session_id and cwd");
    const supported = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];
    if (!supported.includes(event)) return {};
    // Subagent events must not finalize or contaminate the main task.
    if (payload.agent_id || payload.parent_agent_id) return {};
    const turn = stringValue(payload.turn_id);
    if (event !== "SessionStart" && event !== "SessionEnd" && !turn) throw new Error("Codex hook requires turn_id; update Codex");
    const short = event === "Interrupt" || event === "SessionEnd";
    const client = nativeClient("codex", session, resolve(cwd), {
      ...options, ...(short ? { recover: false, timeoutMs: Math.min(options.timeoutMs ?? 1_500, 1_500) } : {}),
    });
    const id = (kind: string, identity = turn) => nativeEventId("codex", session, kind, identity);
    const start = id("start");
    if (event === "UserPromptSubmit") {
      const task = stringValue(payload.prompt).trim();
      if (!task) return {};
      const result = await client.start(start, task);
      return result.context?.trim() ? {
        hookSpecificOutput: { hookEventName: event, additionalContext: result.context },
      } : {};
    }
    if (event === "SessionStart") { await client.register(); return {}; }
    if (short) {
      await client.abort(id(event, turn || stringValue(payload.reason) || "session-end"),
        event === "Interrupt" ? "Codex turn interrupted." : "Codex session ended before task completion.",
        turn ? start : undefined);
      return {};
    }
    if (event === "PreToolUse" || event === "PostToolUse") {
      const toolId = stringValue(payload.tool_use_id);
      if (!toolId) throw new Error("Codex tool hook requires tool_use_id");
      // Codex 0.165 Bash responses are raw stdout, including on nonzero exit.
      // Keep text inside an object: the generic legacy text parser must not
      // mistake a command printing "exit code 0" for collector evidence.
      const response = typeof payload.tool_response === "string"
        ? { output: payload.tool_response.slice(0, 100_000) } : payload.tool_response;
      await client.record(id(event, `${turn}:${toolId}`), event === "PreToolUse" ? "tool_call" : "tool_result", {
        toolName: payload.tool_name, toolInput: payload.tool_input, toolUseId: toolId,
        ...(event === "PostToolUse" ? { toolResponse: response } : {}),
      }, start);
      return {};
    }
    if (event === "Stop") {
      const summary = stringValue(payload.last_assistant_message);
      // Missing final text is not sufficient evidence of a successful turn.
      await client.finish(id("finish"), start, summary, summary.trim() ? undefined : "partial");
    }
    return {};
  } catch (error) {
    const message = bridgeUnavailableMessage(error);
    (options.onWarning ?? ((value: string) => console.error(`[RepoMind] ${value}`)))(message);
    return { systemMessage: message };
  }
}
