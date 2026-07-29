export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmRunnerRequest {
  messages: LlmMessage[];
  responseSchema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmRunnerResult {
  output: unknown;
  usage?: LlmUsage;
}

/** A deliberately small boundary so extraction is fully testable without a network. */
export interface LlmRunner {
  readonly id: string;
  readonly model: string;
  readonly remote: boolean;
  run(request: LlmRunnerRequest): Promise<LlmRunnerResult>;
}
