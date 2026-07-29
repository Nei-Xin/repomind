import { OpenAICompatibleLlmRunner } from "./openai-compatible.js";
import type { LlmRunner } from "./runner.js";

function timeoutFromEnvironment(value: string | undefined): number {
  if (value === undefined) return 60_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error(`Invalid REPOMIND_EXTRACTION_TIMEOUT_MS: ${value}`);
  }
  return parsed;
}

export function extractionRunnerFromEnvironment(): LlmRunner | null {
  const provider = process.env.REPOMIND_EXTRACTION_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled" || provider === "none") return null;
  if (provider === "openai-compatible" || provider === "openai") {
    const baseUrl = process.env.REPOMIND_EXTRACTION_BASE_URL?.trim();
    const apiKey = process.env.REPOMIND_EXTRACTION_API_KEY?.trim();
    const model = process.env.REPOMIND_EXTRACTION_MODEL?.trim();
    if (!baseUrl || !apiKey || !model) {
      throw new Error("OpenAI-compatible extraction requires REPOMIND_EXTRACTION_BASE_URL, REPOMIND_EXTRACTION_API_KEY, and REPOMIND_EXTRACTION_MODEL");
    }
    return new OpenAICompatibleLlmRunner({
      baseUrl,
      apiKey,
      model,
      timeoutMs: timeoutFromEnvironment(process.env.REPOMIND_EXTRACTION_TIMEOUT_MS),
    });
  }
  throw new Error(`Unsupported REPOMIND_EXTRACTION_PROVIDER: ${provider}`);
}
