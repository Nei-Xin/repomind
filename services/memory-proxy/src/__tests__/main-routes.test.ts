import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";
import { __resetProxyStorageForTests } from "../storage/factory.js";

afterEach(() => {
  vi.restoreAllMocks();
  __resetProxyStorageForTests();
});

function testConfig(upstreamPath: string) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = `https://upstream.example.test${upstreamPath}`;
  config.log.file = "";
  config.storage = { ...config.storage, enabled: false };
  config.creditPricing = { models: [] };
  return config;
}

function streamResponse(events: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function interruptedStreamResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"));
      controller.error(new Error("upstream stream interrupted"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("MemoryProxy primary protocol forwarding", () => {
  it("passes through OpenAI SSE events while consuming the stream tap", async () => {
    const events = [
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n",
      "data: [DONE]\n\n",
    ];
    const upstream = vi.fn(async () => streamResponse(events));
    vi.stubGlobal("fetch", upstream);
    const app = createApp(testConfig("/chat/completions"));

    const response = await app.request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(events.join(""));
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("passes through Anthropic SSE events without changing event framing", async () => {
    const events = [
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-test\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];
    const upstream = vi.fn(async () => streamResponse(events));
    vi.stubGlobal("fetch", upstream);
    const app = createApp(testConfig("/v1/messages"));

    const response = await app.request("http://proxy/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(events.join(""));
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("propagates an OpenAI SSE interruption instead of reporting a clean stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => interruptedStreamResponse()));
    const app = createApp(testConfig("/chat/completions"));

    const response = await app.request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    await expect(response.text()).rejects.toThrow("upstream stream interrupted");
  });

  it("forwards OpenAI Chat Completions and preserves the upstream response", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://upstream.example.test/chat/completions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "chat-1" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const app = createApp(testConfig("/chat/completions"));

    const response = await app.request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("chat-1");
    expect(await response.json()).toMatchObject({ id: "chatcmpl-test", choices: [{ message: { content: "hi" } }] });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("forwards Anthropic Messages without changing the response envelope", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://upstream.example.test/v1/messages");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      });
      return new Response(JSON.stringify({
        id: "msg-test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const app = createApp(testConfig("/v1/messages"));

    const response = await app.request("http://proxy/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "msg-test", content: [{ type: "text", text: "hi" }] });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("returns a protocol error when the upstream request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("upstream unavailable");
    }));
    const app = createApp(testConfig("/chat/completions"));

    const response = await app.request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Upstream request failed" });
  });
});
