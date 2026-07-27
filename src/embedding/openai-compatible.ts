import { z } from "zod";
import type { EmbeddingProvider } from "./provider.js";

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-compatible";
  readonly remote = true;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly timeoutMs: number;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}`);
    const parsed = responseSchema.parse(await response.json());
    return parsed.data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
  }
}
