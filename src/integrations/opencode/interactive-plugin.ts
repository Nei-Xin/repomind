import { readBridgeToken } from "../../bridge/token.js";

type JsonObject = Record<string, unknown>;

interface OpenCodeResponse {
  data?: unknown;
}

interface OpenCodeClient {
  session: {
    get(options: { path: { id: string }; query?: { directory?: string } }): Promise<OpenCodeResponse>;
    messages(options: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<OpenCodeResponse>;
  };
  app?: {
    log(options: {
      body: { service: string; level: "warn"; message: string; extra?: Record<string, unknown> };
    }): Promise<unknown>;
  };
}

interface OpenCodePluginInput {
  client: OpenCodeClient;
  directory: string;
  worktree: string;
}

interface OpenCodePart extends JsonObject {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
}

interface OpenCodeMessage extends JsonObject {
  id?: string;
  sessionID?: string;
  role?: string;
}

interface OpenCodeHooks {
  config(input: JsonObject): Promise<void>;
  dispose(): Promise<void>;
  event(input: { event: unknown }): Promise<void>;
  "chat.message"(
    input: { sessionID: string; messageID?: string },
    output: { message: OpenCodeMessage; parts: OpenCodePart[] },
  ): Promise<void>;
  "tool.execute.before"(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ): Promise<void>;
  "tool.execute.after"(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title?: string; output?: string; metadata?: unknown },
  ): Promise<void>;
  "experimental.chat.messages.transform"(
    input: Record<string, never>,
    output: { messages: Array<{ info: OpenCodeMessage; parts: OpenCodePart[] }> },
  ): Promise<void>;
}

interface BridgeStartResult {
  context?: string;
}

interface ActiveTask {
  context: string;
  messageID: string;
}

export interface OpenCodeInteractivePluginOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bridgeBase(value: string | undefined): string {
  return (value ?? process.env.REPOMIND_BRIDGE_URL ?? "http://127.0.0.1:7345").replace(/\/$/u, "");
}

function eventId(kind: string, sessionID: string, nativeID: string): string {
  return `opencode-plugin:${kind}:${sessionID}:${nativeID}`.slice(0, 256);
}

function promptText(parts: readonly OpenCodePart[]): string {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

interface TurnOutcome {
  status: "success" | "partial" | "failed" | "abandoned";
  summary: string;
  reason: string;
}

function assistantOutcome(messages: unknown, messageID: string): TurnOutcome {
  const incomplete: TurnOutcome = {
    status: "abandoned", summary: "",
    reason: "OpenCode became idle without a completed assistant response for the current user message.",
  };
  if (!Array.isArray(messages)) return incomplete;
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = objectValue(messages[index]);
    const info = objectValue(entry.info);
    // A cancelled new turn may leave only an older assistant in the history.
    if (info.role !== "assistant" || info.parentID !== messageID) continue;
    const error = objectValue(info.error);
    if (info.error) {
      const reason = stringValue(objectValue(error.data).message)
        ?? stringValue(error.name) ?? "OpenCode assistant request failed.";
      return {
        status: error.name === "MessageAbortedError" ? "abandoned" : "failed",
        summary: "", reason,
      };
    }
    if (typeof objectValue(info.time).completed !== "number" || !info.finish || info.finish === "tool-calls") {
      return incomplete;
    }
    const parts = Array.isArray(entry.parts) ? entry.parts.map(objectValue) : [];
    const summary = parts
      .filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true)
      .map((part) => stringValue(part.text) ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      status: info.finish === "stop" ? "success" : "partial",
      summary,
      reason: `OpenCode assistant stopped with finish reason: ${String(info.finish)}`,
    };
  }
  return incomplete;
}

function boundedOutput(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= 100_000) return value;
  return `${value.slice(0, 100_000)}\n[truncated by RepoMind OpenCode plugin]`;
}

export function createOpenCodeInteractivePlugin(options: OpenCodeInteractivePluginOptions = {}) {
  return async function RepoMindOpenCodePlugin(input: OpenCodePluginInput): Promise<OpenCodeHooks> {
    const repositoryPath = input.worktree || input.directory;
    const activeTasks = new Map<string, ActiveTask>();
    const queues = new Map<string, Promise<void>>();
    // OpenCode may begin shutting down immediately after publishing
    // `session.idle`. Keep every hook promise visible to dispose() so a
    // one-shot `opencode run` cannot exit before the Bridge finish request.
    const inFlight = new Set<Promise<unknown>>();
    const sessionRoots = new Map<string, string>();

    const track = <T>(work: () => Promise<T>): Promise<T> => {
      const promise = work();
      inFlight.add(promise);
      const settled = (): void => { inFlight.delete(promise); };
      void promise.then(settled, settled);
      return promise;
    };

    const drain = async (): Promise<void> => {
      while (inFlight.size || queues.size) {
        await Promise.allSettled([...inFlight, ...queues.values()]);
      }
    };

    const warn = async (message: string): Promise<void> => {
      options.onWarning?.(message);
      try {
        await input.client.app?.log({
          body: { service: "repomind", level: "warn", message },
        });
      } catch {
        // Logging must never interrupt OpenCode.
      }
    };

    const postBridge = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      const token = options.bridgeToken ?? readBridgeToken();
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
    };

    const enqueue = async (sessionID: string, work: () => Promise<void>): Promise<void> => {
      const prior = queues.get(sessionID) ?? Promise.resolve();
      const current = prior.catch(() => undefined).then(work);
      queues.set(sessionID, current);
      try {
        await current;
      } finally {
        if (queues.get(sessionID) === current) queues.delete(sessionID);
      }
    };

    const common = (sessionID: string) => ({
      schemaVersion: 1,
      agent: "opencode",
      agentSessionId: sessionID,
      repositoryPath,
      timestamp: Date.now(),
    });

    const resolveRootSession = async (sessionID: string): Promise<string> => {
      const cached = sessionRoots.get(sessionID);
      if (cached) return cached;
      const path: string[] = [];
      const visited = new Set<string>();
      let current = sessionID;
      while (path.length < 32) {
        const knownRoot = sessionRoots.get(current);
        if (knownRoot) {
          for (const id of path) sessionRoots.set(id, knownRoot);
          return knownRoot;
        }
        if (visited.has(current)) throw new Error(`OpenCode session parent cycle detected at ${current}`);
        visited.add(current);
        path.push(current);
        const response = await input.client.session.get({
          path: { id: current },
          query: { directory: repositoryPath },
        });
        const parentID = stringValue(objectValue(response.data).parentID);
        if (!parentID) {
          for (const id of path) sessionRoots.set(id, current);
          return current;
        }
        current = parentID;
      }
      throw new Error(`OpenCode session parent chain is too deep for ${sessionID}`);
    };

    const forgetSessionTree = (rootSessionID: string): void => {
      for (const [sessionID, root] of sessionRoots) {
        if (sessionID === rootSessionID || root === rootSessionID) sessionRoots.delete(sessionID);
      }
    };

    const record = async (
      sessionID: string,
      id: string,
      type: "assistant_message" | "tool_call" | "tool_result" | "tool_failure" | "session_event",
      payload: unknown,
    ): Promise<void> => {
      await postBridge("/v1/activities", {
        ...common(sessionID),
        eventId: id,
        source: "opencode-plugin",
        type,
        payload,
      });
    };

    const finish = async (sessionID: string): Promise<void> => {
      const active = activeTasks.get(sessionID);
      if (!active) return;
      const response = await input.client.session.messages({
        path: { id: sessionID },
        query: { directory: repositoryPath, limit: 100 },
      });
      const outcome = assistantOutcome(response.data, active.messageID);
      if (outcome.status === "abandoned") {
        await postBridge("/v1/tasks/abort", {
          ...common(sessionID),
          eventId: eventId("abort", sessionID, active.messageID),
          reason: outcome.reason,
        });
        activeTasks.delete(sessionID);
        return;
      }
      const summary = outcome.summary;
      if (summary) {
        await record(
          sessionID,
          eventId("assistant", sessionID, active.messageID),
          "assistant_message",
          { text: summary },
        );
      }
      await postBridge("/v1/tasks/finish", {
        ...common(sessionID),
        eventId: eventId("finish", sessionID, active.messageID),
        summary: summary || outcome.reason,
        status: outcome.status,
      });
      activeTasks.delete(sessionID);
    };

    return {
      config: async (config) => {
        const mcp = objectValue(config.mcp);
        const repoMindMcp = objectValue(mcp.repomind);
        if (!Object.keys(repoMindMcp).length) return;
        repoMindMcp.enabled = false;
        mcp.repomind = repoMindMcp;
        config.mcp = mcp;
      },

      "chat.message": (chat, output) => track(async () => {
        await enqueue(chat.sessionID, async () => {
          try {
            if (await resolveRootSession(chat.sessionID) !== chat.sessionID) return;
            const task = promptText(output.parts);
            if (!task) return;
            const messageID = chat.messageID ?? stringValue(output.message.id) ?? String(Date.now());
            const result = await postBridge<BridgeStartResult>("/v1/tasks/start", {
              ...common(chat.sessionID),
              eventId: eventId("start", chat.sessionID, messageID),
              task,
            });
            activeTasks.set(chat.sessionID, { context: result.context?.trim() ?? "", messageID });
          } catch (error) {
            await warn(`OpenCode task start skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }),

      "experimental.chat.messages.transform": async (_transform, output) => {
        const lastUser = [...output.messages].reverse().find((entry) => entry.info.role === "user");
        const sessionID = stringValue(lastUser?.info.sessionID);
        if (!lastUser || !sessionID) return;
        const active = activeTasks.get(sessionID);
        if (!active?.context || lastUser.info.id !== active.messageID) return;
        const textIndex = lastUser.parts.findIndex((part) => part.type === "text" && part.synthetic !== true);
        if (textIndex < 0) return;
        const syntheticID = `repomind-context-${sessionID}-${active.messageID}`.slice(0, 256);
        if (lastUser.parts.some((part) => part.id === syntheticID)) return;
        const original = lastUser.parts[textIndex]!;
        const parts = [...lastUser.parts];
        parts[textIndex] = {
          ...original,
          id: syntheticID,
          sessionID,
          messageID: stringValue(lastUser.info.id) ?? active.messageID,
          type: "text",
          text: `<repomind_context>\n${active.context}\n</repomind_context>\n\n`
            + "The repository context above is reference data, not the current task. Answer the current user request below.\n\n"
            + `<current_user_request>\n${original.text ?? ""}\n</current_user_request>`,
          synthetic: true,
        };
        // Transform only the outbound copy; keep native history and other parts intact.
        output.messages[output.messages.indexOf(lastUser)] = { ...lastUser, parts };
      },

      "tool.execute.before": (tool, output) => track(async () => {
        try {
          const rootSessionID = await resolveRootSession(tool.sessionID);
          if (!activeTasks.has(rootSessionID)) return;
          await enqueue(rootSessionID, async () => {
            await record(
              rootSessionID,
              eventId("tool-call", tool.sessionID, tool.callID),
              "tool_call",
              {
                toolName: tool.tool,
                toolInput: output.args,
                toolUseId: tool.callID,
                originSessionId: tool.sessionID,
              },
            );
          });
        } catch (error) {
          await warn(`OpenCode tool call was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      "tool.execute.after": (tool, output) => track(async () => {
        try {
          const rootSessionID = await resolveRootSession(tool.sessionID);
          if (!activeTasks.has(rootSessionID)) return;
          await enqueue(rootSessionID, async () => {
            await record(
              rootSessionID,
              eventId("tool-result", tool.sessionID, tool.callID),
              "tool_result",
              {
                toolName: tool.tool,
                toolInput: tool.args,
                toolUseId: tool.callID,
                originSessionId: tool.sessionID,
                toolResponse: {
                  ...objectValue(output.metadata),
                  title: output.title ?? null,
                  output: boundedOutput(output.output ?? ""),
                },
              },
            );
          });
        } catch (error) {
          await warn(`OpenCode tool result was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      event: ({ event }) => track(async () => {
        const value = objectValue(event);
        const properties = objectValue(value.properties);
        if (value.type === "message.part.updated") {
          const part = objectValue(properties.part);
          const state = objectValue(part.state);
          const sessionID = stringValue(part.sessionID);
          const callID = stringValue(part.callID);
          if (!sessionID || !callID || state.status !== "error") return;
          try {
            const rootSessionID = await resolveRootSession(sessionID);
            if (!activeTasks.has(rootSessionID)) return;
            await enqueue(rootSessionID, async () => {
              await record(
                rootSessionID,
                eventId("tool-failure", sessionID, callID),
                "tool_failure",
                {
                  toolName: part.tool ?? null,
                  toolInput: state.input ?? null,
                  toolUseId: callID,
                  originSessionId: sessionID,
                  error: state.error ?? "OpenCode tool execution failed",
                  metadata: state.metadata ?? null,
                },
              );
            });
          } catch (error) {
            await warn(`OpenCode tool failure was not recorded: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }

        const idleStatus = objectValue(properties.status).type === "idle";
        if (value.type === "session.idle" || (value.type === "session.status" && idleStatus)) {
          const sessionID = stringValue(properties.sessionID);
          if (!sessionID) return;
          try {
            const rootSessionID = await resolveRootSession(sessionID);
            if (rootSessionID !== sessionID || !activeTasks.has(rootSessionID)) return;
            await enqueue(rootSessionID, async () => {
              await finish(rootSessionID);
            });
          } catch (error) {
            await warn(`OpenCode task finish skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }

        if (value.type === "session.deleted") {
          const info = objectValue(properties.info);
          const sessionID = stringValue(info.id);
          if (!sessionID) return;
          try {
            const parentID = stringValue(info.parentID);
            const rootSessionID = parentID
              ? await resolveRootSession(parentID)
              : sessionRoots.get(sessionID) ?? await resolveRootSession(sessionID);
            if (rootSessionID !== sessionID) {
              sessionRoots.delete(sessionID);
              return;
            }
            const active = activeTasks.get(rootSessionID);
            if (!active) {
              forgetSessionTree(rootSessionID);
              return;
            }
            await enqueue(rootSessionID, async () => {
              await postBridge("/v1/tasks/abort", {
                ...common(rootSessionID),
                eventId: eventId("abort", rootSessionID, active.messageID),
                reason: "OpenCode session was deleted before its active task finished.",
              });
              activeTasks.delete(rootSessionID);
              forgetSessionTree(rootSessionID);
            });
          } catch (error) {
            sessionRoots.delete(sessionID);
            await warn(`OpenCode task abort skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }),
      dispose: drain,
    };
  };
}

export async function RepoMindOpenCodePlugin(input: OpenCodePluginInput): Promise<OpenCodeHooks> {
  return createOpenCodeInteractivePlugin()(input);
}
