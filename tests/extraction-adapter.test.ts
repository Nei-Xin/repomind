import { afterEach, describe, expect, it, vi } from "vitest";
import { extractionRunnerFromEnvironment } from "../src/extraction/config.js";
import { OpenAICompatibleLlmRunner } from "../src/extraction/openai-compatible.js";

const request = {
  messages: [{ role: "system" as const, content: "Return structured data." }],
  responseSchema: { type: "object", properties: {} },
};

describe("OpenAI-compatible extraction adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.REPOMIND_EXTRACTION_PROVIDER;
    delete process.env.REPOMIND_EXTRACTION_BASE_URL;
    delete process.env.REPOMIND_EXTRACTION_API_KEY;
    delete process.env.REPOMIND_EXTRACTION_MODEL;
    delete process.env.REPOMIND_EXTRACTION_TIMEOUT_MS;
  });

  it("sends an authenticated strict structured-output request and parses usage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"candidates\":[]}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const runner = new OpenAICompatibleLlmRunner({ baseUrl: "https://llm.example/v1/", apiKey: "test-secret", model: "test-model" });
    await expect(runner.run(request)).resolves.toEqual({ output: { candidates: [] }, usage: { inputTokens: 12, outputTokens: 5 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-secret" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "test-model", temperature: 0, response_format: { type: "json_schema", json_schema: { strict: true } } });
  });

  it("rejects malformed model JSON and remote HTTP failures", async () => {
    const runner = new OpenAICompatibleLlmRunner({ baseUrl: "https://llm.example/v1", apiKey: "secret", model: "model" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 })));
    await expect(runner.run(request)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(runner.run(request)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: "Remote extraction request failed with HTTP 503" });
  });

  it("requires separate explicit environment configuration", () => {
    expect(extractionRunnerFromEnvironment()).toBeNull();
    process.env.REPOMIND_EXTRACTION_PROVIDER = "openai-compatible";
    expect(() => extractionRunnerFromEnvironment()).toThrow("REPOMIND_EXTRACTION_BASE_URL");
    process.env.REPOMIND_EXTRACTION_BASE_URL = "https://llm.example/v1";
    process.env.REPOMIND_EXTRACTION_API_KEY = "secret";
    process.env.REPOMIND_EXTRACTION_MODEL = "model";
    process.env.REPOMIND_EXTRACTION_TIMEOUT_MS = "90000";
    expect(extractionRunnerFromEnvironment()).toMatchObject({ id: "openai-compatible", model: "model", timeoutMs: 90_000, remote: true });
  });
});
