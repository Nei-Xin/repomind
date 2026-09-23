import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createAdaptorServer } from "@hono/node-server";
import * as guard from "../guard-adapter.js";
import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";
import * as logger from "../logger.js";
import * as prepare from "../request-prepare-adapter.js";
import * as skills from "../skill/handler-glue.js";
import * as memory from "../tdai/recorder.js";
import * as repomind from "../repomind/client.js";
import * as langfuse from "../langfuse.js";
import * as intent from "../session/model-intent-telemetry.js";
import * as credit from "../credit-reporter.js";
import * as rateLimit from "../rate-limit/guard.js";
import { __resetProxyStorageForTests } from "../storage/factory.js";

const protocols = [
  {
    name: "OpenAI", path: "/v1/chat/completions", model: "gpt-test",
    partial: 'data: {"choices":[{"delta":{"content":"partial","tool_calls":[{"index":0,"id":"tool-1","function":{"name":"read","arguments":"{}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
    terminal: "data: [DONE]\n\n",
    error: 'data: {"error":{"message":"overloaded"}}\n\n',
  },
  {
    name: "Anthropic", path: "/v1/messages", model: "claude-test",
    partial: 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
      + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"read"}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    terminal: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    error: 'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
  },
] as const;

const pipe: logger.Pipeline = {
  requestReceived: vi.fn(), forwardStart: vi.fn(), forwardDone: vi.fn(),
  streamStart: vi.fn(), streamDone: vi.fn(), streamError: vi.fn(),
  responseDone: vi.fn(), info: vi.fn(), error: vi.fn(), summary: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "createPipeline").mockReturnValue(pipe);
  vi.spyOn(logger, "writeLog").mockImplementation(() => {});
  vi.spyOn(prepare, "notifyUpstreamResponse").mockResolvedValue(undefined);
  vi.spyOn(skills, "triggerSkillExtractIfReady").mockResolvedValue(undefined);
  vi.spyOn(memory, "recordTdaiTurn").mockResolvedValue(undefined);
  vi.spyOn(repomind, "recordRepoMindTurn").mockResolvedValue(undefined);
  vi.spyOn(langfuse, "langfuseReportGeneration").mockImplementation(() => {});
  vi.spyOn(langfuse, "langfuseReportFailure").mockImplementation(() => {});
  vi.spyOn(intent, "emitModelIntentTelemetry").mockImplementation(() => {});
  vi.spyOn(credit, "tryReportCreditFromPath").mockResolvedValue({ attempted: false, ok: true });
  vi.spyOn(rateLimit, "recordInputTokenUsage").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetProxyStorageForTests();
});

async function openStream(protocol: typeof protocols[number], options: { signal?: AbortSignal; partial?: boolean; timeoutMs?: number } = {}) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; }, cancel,
  });
  let fetchSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }));
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = `https://upstream.example.test${protocol.path}`;
  config.server.forwardTimeoutMs = options.timeoutMs ?? config.server.forwardTimeoutMs;
  config.tdai.enabled = true;
  config.tdai.endpoint = "https://memory.example.test";
  config.tdai.memory.enabled = true;
  const response = await createApp(config).request(`http://proxy${protocol.path}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: options.signal,
    body: JSON.stringify({
      model: protocol.model, max_tokens: 32, stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const reader = response.body!.getReader();
  if (options.partial !== false) {
    source.enqueue(new TextEncoder().encode(protocol.partial));
    // Prove actual partial content reached the client before interrupting.
    expect((await reader.read()).done).toBe(false);
  }
  return { source, reader, cancel, body, fetchSignal };
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) { /* Consume to completion/error. */ }
}

function expectNoSuccessEffects() {
  expect(pipe.streamDone).not.toHaveBeenCalled();
  expect(prepare.notifyUpstreamResponse).not.toHaveBeenCalled();
  expect(skills.triggerSkillExtractIfReady).not.toHaveBeenCalled();
  expect(memory.recordTdaiTurn).not.toHaveBeenCalled();
  expect(repomind.recordRepoMindTurn).not.toHaveBeenCalled();
  expect(langfuse.langfuseReportGeneration).not.toHaveBeenCalled();
  expect(intent.emitModelIntentTelemetry).not.toHaveBeenCalled();
  expect(logger.writeLog).not.toHaveBeenCalled();
  expect(credit.tryReportCreditFromPath).not.toHaveBeenCalled();
  expect(rateLimit.recordInputTokenUsage).not.toHaveBeenCalled();
}

for (const protocol of protocols) {
  describe(`${protocol.name} stream finalization`, () => {
    it("aborts a pending upstream fetch without retrying after client disconnect", async () => {
      const abort = new AbortController();
      vi.spyOn(guard, "resolveForwardTarget").mockResolvedValue({
        url: "https://upstream.example.test", model: protocol.model,
        authHeaders: null, bodyOverrides: null, turnSeq: 1, routedFrom: "",
        retryTarget: { url: "https://retry.example.test", model: protocol.model, authHeaders: null },
      });
      const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      vi.stubGlobal("fetch", fetch);
      const request = createApp(structuredClone(DEFAULT_CONFIG)).request(`http://proxy${protocol.path}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ model: protocol.model, stream: true, max_tokens: 32,
          messages: [{ role: "user", content: "hello" }] }),
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      abort.abort(new Error("client disconnected"));
      await request;
      expect(fetch).toHaveBeenCalledTimes(1);
      expectNoSuccessEffects();
    });

    it("closes the real upstream connection when the HTTP client disconnects", async () => {
      const upstreamClosed = vi.fn();
      const upstream = createServer((_req, res) => {
        res.on("close", upstreamClosed);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(protocol.partial);
      });
      let proxy: Server | undefined;
      const clientAbort = new AbortController();
      try {
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const config = structuredClone(DEFAULT_CONFIG);
        config.upstream.url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}${protocol.path}`;
        proxy = createAdaptorServer({ fetch: createApp(config).fetch }) as Server;
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}${protocol.path}`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: clientAbort.signal,
          body: JSON.stringify({ model: protocol.model, stream: true, max_tokens: 32,
            messages: [{ role: "user", content: "hello" }] }),
        });
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        clientAbort.abort();
        await vi.waitFor(() => expect(upstreamClosed).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1));
        expectNoSuccessEffects();
      } finally {
        clientAbort.abort();
        for (const server of [proxy, upstream]) {
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      }
    });

    it("preserves successful finalization exactly once", async () => {
      const { source, reader } = await openStream(protocol);
      source.enqueue(new TextEncoder().encode(protocol.terminal));
      source.close();
      await drain(reader);
      await vi.waitFor(() => expect(credit.tryReportCreditFromPath).toHaveBeenCalledTimes(1));
      expect(pipe.streamDone).toHaveBeenCalledTimes(1);
      expect(pipe.streamError).not.toHaveBeenCalled();
      expect(prepare.notifyUpstreamResponse).toHaveBeenCalledTimes(1);
      expect(prepare.notifyUpstreamResponse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: "partial" }), pipe);
      expect(skills.triggerSkillExtractIfReady).toHaveBeenCalledTimes(1);
      expect(memory.recordTdaiTurn).toHaveBeenCalledTimes(1);
      if (protocol.name === "Anthropic") expect(repomind.recordRepoMindTurn).toHaveBeenCalledTimes(1);
      expect(langfuse.langfuseReportGeneration).toHaveBeenCalledTimes(1);
      expect(intent.emitModelIntentTelemetry).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])("cancels upstream promptly when the client stops (partial=%s)", async (partial) => {
      const { reader, cancel, body, fetchSignal } = await openStream(protocol, { partial });
      await reader.cancel();
      await vi.waitFor(() => expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1));
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(body.locked).toBe(false));
      expectNoSuccessEffects();
    });

    it("propagates request disconnects while waiting for the next chunk", async () => {
      const requestAbort = new AbortController();
      const { reader, cancel, body, fetchSignal } = await openStream(protocol, { signal: requestAbort.signal });
      const reading = expect(drain(reader)).rejects.toThrow("client disconnected");
      requestAbort.abort(new Error("client disconnected"));
      await reading;
      await vi.waitFor(() => expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1));
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(body.locked).toBe(false));
      expectNoSuccessEffects();
    });

    it("terminates both reading and writing when the forwarding timeout expires", async () => {
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const { reader, cancel, body } = await openStream(protocol);
      const reading = expect(drain(reader)).rejects.toThrow("upstream timed out");
      timeout.abort(new Error("upstream timed out"));
      await reading;
      await vi.waitFor(() => expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1));
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(body.locked).toBe(false));
      expectNoSuccessEffects();
    });

    it.each(["transport", "EOF", "SSE error"])("skips success effects after %s interruption", async (failure) => {
      const { source, reader } = await openStream(protocol);
      if (failure === "transport") {
        source.error(new Error("upstream interrupted"));
        await expect(drain(reader)).rejects.toThrow("upstream interrupted");
      } else {
        if (failure === "SSE error") {
          source.enqueue(new TextEncoder().encode(protocol.error + protocol.terminal));
        }
        source.close();
        await drain(reader);
      }
      await vi.waitFor(() => expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1));
      expect(pipe.streamError).toHaveBeenCalledTimes(1);
      expectNoSuccessEffects();
    });
  });
}

it("terminates the Anthropic client and upstream at the stream timeout", async () => {
  vi.useFakeTimers();
  const { source, reader, cancel, body, fetchSignal } = await openStream(protocols[1]);
  const reading = expect(drain(reader)).rejects.toThrow("Anthropic stream timeout");
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  await reading;
  expect(pipe.streamError).toHaveBeenCalledTimes(1);
  expect(langfuse.langfuseReportFailure).toHaveBeenCalledTimes(1);
  expect(fetchSignal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(() => source.enqueue(new TextEncoder().encode(protocols[1].terminal))).toThrow();
  expectNoSuccessEffects();
});
