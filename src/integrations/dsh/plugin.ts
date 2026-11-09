import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { bridgeUnavailableMessage, type BridgeClientOptions } from "../../bridge/client.js";
import { locateGitRoot } from "../../git/git-inspector.js";
import { nativeClient, nativeEventId, objectValue, stringValue, type JsonObject } from "../native/client.js";

// Structural interfaces keep DSH optional. Validated against 0.2.2-rc.1;
// no DSH/Cordis runtime or SQLite instance is bundled into the host plugin.
export interface DshSession { id: string; header: { origin?: string; [key: string]: unknown } }
export interface DshAgent { session: DshSession }
export interface DshMessage { id: string; role: string; source: { kind: string }; content: unknown }
export type DshDecision = { kind: "reject" } | { kind: "enter"; messages: DshMessage[]; startsRequestSeries?: true };
export interface DshStep { agent: DshAgent; messages: DshMessage[]; turn: number; step: number; signal: AbortSignal }
export interface DshEvent { type: string; seq: number; data: JsonObject }
export interface DshExecution { agent?: DshAgent; callId: string; name: string; arguments: unknown }
export interface DshContext {
  workingDirectory: { get(session: DshSession): string };
  effect(setup: () => () => Promise<void>): unknown;
  on(event: "agent/pre-step", listener: (payload: DshStep, next: () => Promise<DshDecision>) => Promise<DshDecision>): unknown;
  on(event: "session/event", listener: (session: DshSession, event: DshEvent) => void): unknown;
  on(event: "tools/result", listener: (exec: DshExecution, result: JsonObject) => void): unknown;
  on(event: "session/flush" | "session/disposed", listener: (session: DshSession) => Promise<void> | void): unknown;
}
export interface DshPluginOptions extends BridgeClientOptions {
  repository: string;
  onWarning?: (message: string) => void;
}
interface Task {
  start: string;
  turn: number;
  summary: string;
  incomplete: boolean;
  calls: Map<string, { name: string; input: unknown }>;
  results: Set<string>;
  prompts: Set<string>;
}
interface SessionState {
  session: DshSession;
  client: ReturnType<typeof nativeClient>;
  queue: Promise<void>;
  task?: Task;
  lastSeq: number;
}
function text(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 100_000);
  return Array.isArray(content) ? content.filter(v => objectValue(v).type === "text")
    .map(v => stringValue(objectValue(v).text)).join("\n").slice(0, 100_000) : "";
}
function argumentsValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return { unparsed: value.slice(0, 10_000) }; }
}

export function createDshPlugin(options: DshPluginOptions) {
  return (ctx: DshContext): void => {
    const repository = realpathSync(locateGitRoot(options.repository));
    const states = new Map<DshSession, SessionState>();
    let disposing = false;
    const warn = (error: unknown) => {
      const message = bridgeUnavailableMessage(error);
      if (options.onWarning) options.onWarning(message);
      else console.error(`[RepoMind DSH] ${message}`);
    };
    const enqueue = <T>(state: SessionState, work: () => Promise<T>): Promise<T | undefined> => {
      const pending = state.queue.then(work).catch(error => {
        if (state.task) state.task.incomplete = true;
        warn(error);
        return undefined;
      });
      state.queue = pending.then(() => {});
      return pending;
    };
    const id = (state: SessionState, kind: string, identity: string) => nativeEventId("dsh", state.session.id, kind, identity);
    const abort = async (state: SessionState, reason: string) => {
      const task = state.task;
      delete state.task;
      if (task) await state.client.abort(id(state, "abort", task.start), reason, task.start);
    };
    const sameRepository = (session: DshSession) => {
      try { return realpathSync(locateGitRoot(ctx.workingDirectory.get(session))) === repository; }
      catch { return false; }
    };

    ctx.on("agent/pre-step", async (payload, next) => {
      // Preserve other plugins' rejection/rewrite decisions before starting a task.
      const decision = await next();
      const session = payload.agent.session;
      if (disposing || decision.kind !== "enter" || session.header.origin === "subagent") return decision;
      let state = states.get(session);
      if (!sameRepository(session)) {
        if (state) await enqueue(state, () => abort(state!, "DSH changed to another repository."));
        return decision;
      }
      const users = decision.messages.filter(m => m.source.kind === "user" && text(m.content).trim());
      if (!state && !users.length) return decision;
      if (!state) {
        state = { session, client: nativeClient("dsh", session.id, repository, options), queue: Promise.resolve(), lastSeq: -1 };
        states.set(session, state);
      }
      const current = state;
      const context = await enqueue(current, async () => {
        if (payload.signal.aborted || !users.length) return "";
        if (current.task && current.task.turn !== payload.turn) await abort(current, "DSH previous turn did not settle before a new task.");
        if (!current.task) {
          const start = id(current, "start", `${payload.turn}:${users.map(m => m.id).join(":")}`);
          const result = await current.client.start(start, users.map(m => text(m.content)).join("\n").slice(0, 100_000));
          current.task = { start, turn: payload.turn, summary: "", incomplete: false,
            calls: new Map(), results: new Set(), prompts: new Set(users.map(m => m.id)) };
          if (payload.signal.aborted) { await abort(current, "DSH interrupted during recall."); return ""; }
          return result.context;
        }
        for (const message of users) {
          if (current.task.prompts.has(message.id)) continue;
          await current.client.record(id(current, "user", message.id), "user_message", { text: text(message.content) }, current.task.start);
          current.task.prompts.add(message.id);
        }
        return "";
      });
      if (!context?.trim()) return decision;
      // Prompt assembly has already happened. Add recall to THIS admitted batch.
      return { ...decision, messages: [...decision.messages, {
        id: randomUUID(), role: "user", source: { kind: "repomind" },
        content: [{ type: "text", text: context }],
      }] };
    });

    ctx.on("tools/result", (exec, result) => {
      const state = exec.agent && states.get(exec.agent.session);
      if (!state) return;
      void enqueue(state, async () => {
        const task = state.task;
        if (!task || task.results.has(exec.callId)) return;
        const input = argumentsValue(exec.arguments);
        if (!task.calls.has(exec.callId)) {
          await state.client.record(id(state, "call", `${task.start}:${exec.callId}`), "tool_call",
            { toolName: exec.name, toolInput: input, toolUseId: exec.callId }, task.start);
          task.calls.set(exec.callId, { name: exec.name, input });
        }
        const value = objectValue(result.value);
        // Only the executor's canonical foreground exit can verify a command.
        // Rendered stdout and background job acceptance never establish success.
        const exit = value.kind === "foreground" && value.timedOut !== true && value.aborted !== true && Number.isInteger(value.exitCode)
          ? value.exitCode : undefined;
        await state.client.record(id(state, "result", `${task.start}:${exec.callId}`),
          result.isError === true ? "tool_failure" : "tool_result", {
            toolName: exec.name, toolInput: input, toolUseId: exec.callId,
            toolResponse: { output: text(result.content), ...(exit === undefined ? {} : { exitCode: exit }) },
          }, task.start);
        task.results.add(exec.callId);
      });
    });

    ctx.on("session/event", (session, event) => {
      const state = states.get(session);
      if (!state) return;
      void enqueue(state, async () => {
        if (event.seq <= state.lastSeq) return;
        state.lastSeq = event.seq;
        const task = state.task;
        if (!task || event.data.turn !== task.turn) return;
        const data = event.data;
        if (event.type === "tool/call") {
          const callId = stringValue(data.callId);
          if (!callId || task.calls.has(callId)) return;
          const name = stringValue(data.name);
          const input = argumentsValue(data.arguments);
          await state.client.record(id(state, "call", `${task.start}:${callId}`), "tool_call",
            { toolName: name, toolInput: input, toolUseId: callId }, task.start);
          task.calls.set(callId, { name, input });
        } else if (event.type === "tool/result") {
          // Custom executors may omit tools/result. Retain their durable result
          // as unverified activity, without parsing exit claims from free text.
          const message = objectValue(data.message);
          const callId = stringValue(message.toolCallId);
          const call = task.calls.get(callId);
          if (!call || task.results.has(callId)) return;
          await state.client.record(id(state, "result", `${task.start}:${callId}`), message.isError === true ? "tool_failure" : "tool_result", {
            toolName: call.name, toolInput: call.input, toolUseId: callId, toolResponse: { output: text(message.content) },
          }, task.start);
          task.results.add(callId);
        } else if (event.type === "assistant/message") {
          task.summary = text(objectValue(data.message).content);
          if (data.interrupted === true) task.incomplete = true;
        } else if (event.type === "turn/end") {
          const reason = stringValue(objectValue(data.reason).kind);
          if (["aborted", "interrupted", "forked"].includes(reason)) {
            await abort(state, `DSH turn ${reason}.`);
            return;
          }
          const status = reason === "error" ? "failed"
            : reason === "completed" && !task.incomplete && task.summary.trim() && task.calls.size === task.results.size ? "success" : "partial";
          await state.client.finish(id(state, "finish", task.start), task.start, task.summary, status);
          delete state.task;
        }
      });
    });
    // DSH emits observations without awaiting listeners. Flush and disposal
    // are the awaited barriers that make headless shutdown drain Bridge writes.
    ctx.on("session/flush", async session => { await states.get(session)?.queue; });
    ctx.on("session/disposed", session => {
      const state = states.get(session);
      if (state) void enqueue(state, async () => { await abort(state, "DSH session disposed before completion."); states.delete(session); });
    });
    // Cordis awaits effect disposers, not an arbitrary event named "dispose".
    // Register last so shutdown starts draining before subscriptions disappear.
    ctx.effect(() => async () => {
      disposing = true;
      await Promise.all([...states.values()].map(state => enqueue(state, () => abort(state, "DSH plugin unloaded before completion."))));
      states.clear();
    });
  };
}

export const name = "repomind";
export const inject = ["agents", "sessions", "tools", "workingDirectory"];
export function apply(ctx: DshContext, config: DshPluginOptions): void { createDshPlugin(config)(ctx); }
