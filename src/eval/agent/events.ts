export interface AgentEventMetrics {
  turns: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  toolCalls: Record<string, number>;
  failedTools: number;
  failedCommands: number;
  fileReads: number;
  repeatedFileReads: number;
  repoMindCalls: number;
  retrievedMemories: number;
}

export interface ParsedAgentEvents {
  events: Array<Record<string, unknown>>;
  malformedLines: number;
}

export function parseAgentEvents(jsonl: string): ParsedAgentEvents {
  const events: Array<Record<string, unknown>> = [];
  let malformedLines = 0;
  for (const line of jsonl.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (!line.trim().startsWith("{")) {
      malformedLines += 1;
      continue;
    }
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) events.push(value as Record<string, unknown>);
      else malformedLines += 1;
    } catch { malformedLines += 1; }
  }
  return { events, malformedLines };
}

export function analyzeAgentEvents(jsonl: string): AgentEventMetrics {
  const { events } = parseAgentEvents(jsonl);
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls = new Map<string, number>();
  const reads = new Map<string, number>();
  let turns = 0;
  let failedTools = 0;
  let failedCommands = 0;
  let retrievedMemories = 0;
  for (const event of events) {
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "step_finish" && part?.tokens) {
      turns += 1;
      const eventTokens = part.tokens as Record<string, unknown>;
      const cache = eventTokens.cache as Record<string, unknown> | undefined;
      tokens.input += Number(eventTokens.input ?? 0);
      tokens.output += Number(eventTokens.output ?? 0);
      tokens.reasoning += Number(eventTokens.reasoning ?? 0);
      tokens.cacheRead += Number(cache?.read ?? 0);
      tokens.cacheWrite += Number(cache?.write ?? 0);
    }
    if (event.type !== "tool_use" || typeof part?.tool !== "string") continue;
    const tool = part.tool;
    toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1);
    const state = (part.state ?? {}) as Record<string, unknown>;
    const metadata = state.metadata as Record<string, unknown> | undefined;
    const input = state.input as Record<string, unknown> | undefined;
    if (state.status !== "completed") failedTools += 1;
    if ((tool === "bash" || tool === "shell") && Number(metadata?.exit ?? 0) !== 0) failedCommands += 1;
    if (tool === "read" && typeof input?.filePath === "string") {
      const path = input.filePath.toLowerCase();
      reads.set(path, (reads.get(path) ?? 0) + 1);
    }
    if (tool === "repomind_repo_session_start" && typeof state.output === "string") {
      try {
        const output = JSON.parse(state.output) as { memories?: unknown[] };
        retrievedMemories = Math.max(retrievedMemories, output.memories?.length ?? 0);
      } catch { /* a truncated MCP result is counted as zero */ }
    }
  }
  return {
    turns,
    tokens,
    toolCalls: Object.fromEntries([...toolCalls].sort(([a], [b]) => a.localeCompare(b))),
    failedTools,
    failedCommands,
    fileReads: [...reads.values()].reduce((sum, count) => sum + count, 0),
    repeatedFileReads: [...reads.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    repoMindCalls: [...toolCalls].filter(([name]) => name.startsWith("repomind_")).reduce((sum, [, count]) => sum + count, 0),
    retrievedMemories,
  };
}
