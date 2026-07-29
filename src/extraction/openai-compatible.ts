import { z } from "zod";
import { RepoMindError } from "../errors.js";
import type { LlmRunner, LlmRunnerRequest, LlmRunnerResult } from "./runner.js";

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().optional(), completion_tokens: z.number().int().optional() }).optional(),
});

export interface OpenAICompatibleLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAICompatibleLlmRunner implements LlmRunner {
  readonly id = "openai-compatible";
  readonly remote = true;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(options: OpenAICompatibleLlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async run(request: LlmRunnerRequest): Promise<LlmRunnerResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: { name: "repomind_memory_candidates", strict: true, schema: request.responseSchema },
        },
      }),
      signal,
    });
    if (!response.ok) throw new RepoMindError("CAPABILITY_UNAVAILABLE", `Remote extraction request failed with HTTP ${response.status}`);
    const parsed = responseSchema.parse(await response.json());
    const first = parsed.choices[0]!.message;
    if (first.refusal) throw new RepoMindError("CAPABILITY_UNAVAILABLE", `Remote extraction was refused: ${first.refusal}`);
    if (!first.content) throw new RepoMindError("INVALID_INPUT", "Remote extraction returned no structured content");
    let output: unknown;
    try {
      output = JSON.parse(first.content);
    } catch {
      throw new RepoMindError("INVALID_INPUT", "Remote extraction returned malformed JSON");
    }
    return {
      output,
      ...(parsed.usage ? {
        usage: {
          ...(parsed.usage.prompt_tokens === undefined ? {} : { inputTokens: parsed.usage.prompt_tokens }),
          ...(parsed.usage.completion_tokens === undefined ? {} : { outputTokens: parsed.usage.completion_tokens }),
        },
      } : {}),
    };
  }
}
