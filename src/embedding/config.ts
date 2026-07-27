import { DeterministicEmbeddingProvider } from "./deterministic.js";
import { OpenAICompatibleEmbeddingProvider } from "./openai-compatible.js";
import type { EmbeddingProvider } from "./provider.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 8) throw new Error(`Invalid embedding dimensions: ${String(value)}`);
  return parsed;
}

export function embeddingProviderFromEnvironment(): EmbeddingProvider | null {
  const provider = process.env.REPOMIND_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled" || provider === "none") return null;
  const dimensions = positiveInteger(process.env.REPOMIND_EMBEDDING_DIMENSIONS, 256);
  if (provider === "deterministic") return new DeterministicEmbeddingProvider(dimensions);
  if (provider === "openai-compatible" || provider === "openai") {
    const baseUrl = process.env.REPOMIND_EMBEDDING_BASE_URL?.trim();
    const apiKey = process.env.REPOMIND_EMBEDDING_API_KEY?.trim();
    const model = process.env.REPOMIND_EMBEDDING_MODEL?.trim();
    if (!baseUrl || !apiKey || !model) {
      throw new Error("OpenAI-compatible embeddings require REPOMIND_EMBEDDING_BASE_URL, REPOMIND_EMBEDDING_API_KEY, and REPOMIND_EMBEDDING_MODEL");
    }
    return new OpenAICompatibleEmbeddingProvider({ baseUrl, apiKey, model, dimensions });
  }
  throw new Error(`Unsupported REPOMIND_EMBEDDING_PROVIDER: ${provider}`);
}
