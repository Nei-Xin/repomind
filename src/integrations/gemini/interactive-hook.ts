import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bridgeUnavailableMessage, type BridgeClientOptions } from "../../bridge/client.js";
import { nativeClient, objectValue, stringValue } from "../native/client.js";
import { closeGeminiTurn, parseGeminiInput, planGeminiHook } from "./state.js";

export interface GeminiHookOptions extends BridgeClientOptions { input?: unknown; onWarning?: (message: string) => void }
export async function handleGeminiInteractiveHook(options: GeminiHookOptions = {}): Promise<Record<string, unknown>> {
  try {
    const input = parseGeminiInput(options.input ?? JSON.parse(readFileSync(0, "utf8")));
    const event = input.hook_event_name;
    if (!["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "BeforeModel", "AfterModel"].includes(event)) return {};
    const receipt = planGeminiHook(input);
    const client = nativeClient("gemini", input.session_id, resolve(input.cwd), {
      ...options, ...(event === "SessionEnd" ? { recover: false, timeoutMs: Math.min(options.timeoutMs ?? 1_500, 1_500) } : {}),
    });
    if (event === "SessionStart") await client.register();
    if (!receipt.start) return {};
    if (event === "BeforeAgent") {
      if (receipt.previous) {
        // A failed/interrupting turn has no guaranteed completion callback in Gemini.
        try { await client.abort(`${receipt.id}:previous`, "Gemini started another prompt before the previous task completed.", receipt.previous); }
        catch (error) { if (!String(error).includes("completed or superseded")) throw error; }
      }
      const result = await client.start(receipt.start, stringValue(input.prompt).trim());
      return result.context?.trim() ? { hookSpecificOutput: { hookEventName: event, additionalContext: result.context } } : {};
    }
    if (event === "SessionStart" || event === "SessionEnd") {
      await client.abort(receipt.id, "Gemini session ended or resumed before task completion.", receipt.start);
      closeGeminiTurn(input, receipt.start);
    } else if (event === "BeforeTool" || event === "AfterTool") {
      const response = objectValue(input.tool_response);
      const data = objectValue(response.data);
      // Only structured collector status counts. Exit 0 is omitted by Gemini 0.66;
      // stdout saying 'Exit Code: 0' is not proof. Background/cancelled runs stay unknown.
      const exitCode = Number.isInteger(data.exitCode) ? data.exitCode : undefined;
      await client.record(receipt.id, event === "BeforeTool" ? "tool_call" : response.error ? "tool_failure" : "tool_result", {
        toolName: input.tool_name === "run_shell_command" ? "shell" : input.tool_name,
        nativeToolName: input.tool_name, toolInput: input.tool_input, toolUseId: receipt.toolId,
        ...(event === "AfterTool" ? { toolResponse: { output: response.llmContent, ...(exitCode === undefined ? {} : { exitCode }),
          ...(response.error ? { isError: true } : {}) } } : {}),
      }, receipt.start);
    } else if (event === "AfterAgent") {
      await client.finish(receipt.id, receipt.start, stringValue(input.prompt_response), receipt.complete ? undefined : "partial");
      closeGeminiTurn(input, receipt.start);
    }
    return {};
  } catch (error) {
    const message = bridgeUnavailableMessage(error);
    (options.onWarning ?? ((value: string) => console.error(`[RepoMind] ${value}`)))(message);
    return { systemMessage: message };
  }
}
