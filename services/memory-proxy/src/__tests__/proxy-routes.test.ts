import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";
import { __resetProxyStorageForTests } from "../storage/factory.js";

afterEach(() => {
  vi.restoreAllMocks();
  __resetProxyStorageForTests();
});

function testConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = "https://upstream.example.test";
  config.upstream.apiKey = "upstream-secret";
  config.log.file = "";
  config.storage = { ...config.storage, enabled: false };
  return config;
}

describe("MemoryProxy request forwarding", () => {
  it("forwards an auxiliary request with protocol-specific authentication", async () => {
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer upstream-secret");
      expect(headers.get("x-api-key")).toBeNull();
      const requestBody = init?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(init.body)
        : String(init?.body);
      expect(JSON.parse(requestBody)).toEqual({ model: "text-embedding-3-small", input: "hello" });
      return new Response(JSON.stringify({ object: "list", data: [{ embedding: [1, 2] }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "upstream-1" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const app = createApp(testConfig());

    const response = await app.request("http://proxy/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-secret",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "list", data: [{ embedding: [1, 2] }] });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(response.headers.get("x-request-id")).toBe("upstream-1");
  });

  it("returns a stable 502 when the auxiliary upstream cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    const app = createApp(testConfig());

    const response = await app.request("http://proxy/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "hello" }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Upstream request failed",
      detail: "connection refused",
    });
  });
});
