/** Optional RepoMind Bridge write-through for coding-agent turns. */

export interface RepoMindTurnInput {
  sessionKey: string;
  traceId: string;
  turnSeq: number;
  userText?: string | null;
  assistantText?: string | null;
}

export interface RepoMindRuntimeConfig {
  enabled?: boolean;
  bridgeUrl?: string;
  bridgeToken?: string;
  timeoutMs?: number;
}

let runtimeConfig: RepoMindRuntimeConfig | undefined;

export function configureRepoMind(config: RepoMindRuntimeConfig): void {
  runtimeConfig = { ...config };
}

function settings(): { base: string; token: string; timeoutMs: number } | null {
  if (runtimeConfig?.enabled === false) return null;
  const value = (runtimeConfig?.bridgeUrl ?? process.env.REPOMIND_BRIDGE_URL ?? "").trim();
  if (!value) return null;
  return {
    base: value.replace(/\/$/u, ""),
    token: (runtimeConfig?.bridgeToken ?? process.env.REPOMIND_BRIDGE_TOKEN ?? "").trim(),
    timeoutMs: runtimeConfig?.timeoutMs ?? Number(process.env.REPOMIND_BRIDGE_TIMEOUT_MS ?? 3000),
  };
}

export function repoMindBridgeStatus(): { enabled: boolean; bridgeUrl: string } {
  const current = settings();
  return { enabled: current !== null, bridgeUrl: current?.base ?? "" };
}

async function recordActivity(body: Record<string, unknown>): Promise<void> {
  const current = settings();
  if (!current) return;
  const { base, token } = current;
  const controller = new AbortController();
  const timeoutMs = Number(current.timeoutMs);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000);
  try {
    const response = await fetch(`${base}/v1/activities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 500);
      throw new Error(`RepoMind Bridge POST /v1/activities HTTP ${response.status}: ${message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function recordRepoMindTurn(input: RepoMindTurnInput): Promise<void> {
  if (!settings() || !input.sessionKey.trim()) return;
  const common = {
    schemaVersion: 1,
    agent: "claude",
    agentSessionId: input.sessionKey,
    source: "memory-proxy",
    sequence: Math.max(0, input.turnSeq),
    timestamp: Date.now(),
  } as const;
  const writes: Promise<void>[] = [];
  if (input.userText?.trim()) {
    writes.push(recordActivity({
      ...common,
      eventId: `memory-proxy:${input.traceId}:user`,
      type: "user_message",
      payload: { text: input.userText },
    }));
  }
  if (input.assistantText?.trim()) {
    writes.push(recordActivity({
      ...common,
      eventId: `memory-proxy:${input.traceId}:assistant`,
      type: "assistant_message",
      payload: { text: input.assistantText },
    }));
  }
  await Promise.all(writes);
}
