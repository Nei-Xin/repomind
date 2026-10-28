import { randomUUID } from "node:crypto";
import { bridgeUnavailableMessage, type BridgeClientOptions } from "../../bridge/client.js";
import { nativeClient, nativeEventId, objectValue, stringValue, type JsonObject } from "../native/client.js";

// Structural boundary keeps the extension optional: RepoMind does not install or
// bundle Pi, and the generated loader imports this module using native ESM.
export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  hasUI?: boolean;
  ui?: { notify(message: string, type: "warning"): void };
}
export interface PiExtensionAPI {
  on(event: string, handler: (event: JsonObject, context: PiContext) => Promise<unknown>): unknown;
}
export interface PiExtensionOptions extends BridgeClientOptions { onWarning?: (message: string) => void }

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => objectValue(part).type === "text")
    .map(part => stringValue(objectValue(part).text)).join("\n").slice(0, 100_000) : "";
}

export function createPiExtension(options: PiExtensionOptions = {}) {
  return (pi: PiExtensionAPI): void => {
    let active: { session: string; start: string; client: ReturnType<typeof nativeClient>; summary: string; outcome: "success" | "partial" | "failed" } | undefined;
    let warned = false;
    let queue: Promise<unknown> = Promise.resolve();
    const on = (event: string, handler: (event: JsonObject, ctx: PiContext) => Promise<unknown>) => {
      pi.on(event, (value, ctx) => {
        const next = queue.then(() => handler(value, ctx)).catch(error => {
          const message = bridgeUnavailableMessage(error);
          if (options.onWarning) options.onWarning(message);
          else console.error(`[RepoMind] ${message}`);
          if (!warned && ctx.hasUI) ctx.ui?.notify(message, "warning");
          warned = true;
        });
        queue = next;
        return next;
      });
    };
    const abort = async (reason: string) => {
      const task = active;
      active = undefined;
      if (task) await task.client.abort(nativeEventId("pi", task.session, "abort", task.start), reason, task.start);
    };
    on("before_agent_start", async (event, ctx) => {
      if (event.messageType === "custom" || !stringValue(event.prompt).trim()) return;
      // Clear previous state even if the next start fails, so later tools cannot
      // accidentally attach to an earlier prompt.
      active = undefined;
      const session = ctx.sessionManager.getSessionId();
      const client = nativeClient("pi", session, ctx.cwd, options);
      const start = nativeEventId("pi", session, "start", randomUUID());
      const result = await client.start(start, stringValue(event.prompt));
      active = { session, start, client, summary: "", outcome: "partial" };
      warned = false;
      if (result.context?.trim()) return {
        message: { customType: "repomind-context", content: result.context, display: false },
      };
    });
    for (const event of ["tool_call", "tool_result"]) on(event, async (value, ctx) => {
      const task = active;
      if (!task || task.session !== ctx.sessionManager.getSessionId()) return;
      const toolId = stringValue(value.toolCallId);
      if (!toolId) return;
      const structured = objectValue(value.structuredContent);
      const response = { output: textContent(value.content),
        ...(Number.isInteger(structured.exit_code) ? { exitCode: structured.exit_code } : {}) };
      await task.client.record(nativeEventId("pi", task.session, event, `${task.start}:${toolId}`),
        event === "tool_call" ? "tool_call" : value.isError === true ? "tool_failure" : "tool_result", {
          toolName: value.toolName, toolInput: value.input, toolUseId: toolId,
          ...(event === "tool_result" ? { toolResponse: response } : {}),
        }, task.start);
    });
    on("message_end", async (event, ctx) => {
      if (!active || active.session !== ctx.sessionManager.getSessionId()) return;
      const message = objectValue(event.message);
      if (message.role !== "assistant") return;
      active.summary = textContent(message.content);
      active.outcome = message.stopReason === "error" || message.stopReason === "aborted" ? "failed"
        : message.stopReason === "stop" ? "success" : "partial";
    });
    // agent_end can be followed by retries/compaction/queued work. Only settled
    // establishes the final idle boundary, and reports Escape cancellation.
    on("agent_settled", async (event) => {
      if (event.aborted === true) { await abort("Pi run interrupted."); return; }
      const task = active;
      if (!task) return;
      active = undefined;
      await task.client.finish(nativeEventId("pi", task.session, "finish", task.start), task.start, task.summary,
        task.summary.trim() || task.outcome === "failed" ? task.outcome : "partial");
    });
    on("session_shutdown", async () => abort("Pi session closed, switched, forked or reloaded before completion."));
    on("session_tree", async () => abort("Pi navigated to another conversation branch."));
  };
}

export default createPiExtension();
