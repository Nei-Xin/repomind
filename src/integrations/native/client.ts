import { createHash } from "node:crypto";
import { postBridgeJson, type BridgeClientOptions } from "../../bridge/client.js";
import type { ActivityType } from "../../protocol/activity.js";

export type NativeAgent = "codex" | "pi" | "gemini";
export type JsonObject = Record<string, unknown>;
export const objectValue = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
export const stringValue = (value: unknown): string => typeof value === "string" ? value : "";

/** Native IDs may exceed the Bridge's limit; scope every event to its session. */
export function nativeEventId(agent: NativeAgent, session: string, kind: string, identity: string): string {
  return `${agent}:${kind}:${createHash("sha256").update(`${session}\0${identity}`).digest("hex")}`;
}

export function nativeClient(agent: NativeAgent, agentSessionId: string, repositoryPath: string, options: BridgeClientOptions = {}) {
  const common = () => ({ schemaVersion: 1, agent, agentSessionId, repositoryPath, timestamp: Date.now() });
  const post = <T>(path: string, body: JsonObject) => postBridgeJson<T>(path, { ...common(), ...body }, options);
  return {
    register: () => post("/v1/sessions/register", {}),
    start: (eventId: string, task: string) => post<{ context: string }>("/v1/tasks/start", { eventId, task }),
    record: (eventId: string, type: ActivityType, payload: unknown, taskStartEventId?: string) => post("/v1/activities", {
      eventId, type, payload, source: { codex: "codex-hook", pi: "pi-extension", gemini: "gemini-hook" }[agent],
      ...(taskStartEventId ? { taskStartEventId } : {}),
    }),
    finish: async (eventId: string, taskStartEventId: string, summary: string, status?: "success" | "partial" | "failed") => {
      if (summary.trim()) await post("/v1/activities", {
        eventId: `${eventId}:assistant`, taskStartEventId, type: "assistant_message",
        source: { codex: "codex-hook", pi: "pi-extension", gemini: "gemini-hook" }[agent], payload: { text: summary.slice(0, 100_000) },
      });
      return post("/v1/tasks/finish", { eventId, taskStartEventId, summary: summary.slice(0, 100_000), ...(status ? { status } : {}) });
    },
    abort: (eventId: string, reason: string, taskStartEventId?: string) => post("/v1/tasks/abort", {
      eventId, reason, ...(taskStartEventId ? { taskStartEventId } : {}),
    }),
  };
}
