import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import type { CommitSessionResult, MemoryResult, StartSessionResult, TestEvidenceInput } from "../../domain/types.js";

export interface HostLifecycleStart {
  sessionId: string;
  startMs: number;
  result: StartSessionResult;
}

export interface OpenCodeCommandEvidence extends TestEvidenceInput {
  isTest: boolean;
}

export interface OpenCodeOutcome {
  summary: string;
  commands: OpenCodeCommandEvidence[];
}

export interface HostLifecycleCommit {
  commitMs: number;
  result: CommitSessionResult;
}

export interface HostLifecycleAbandon {
  abandonMs: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function withDataDirectory<T>(dataDirectory: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.REPOMIND_DATA_DIR;
  if (dataDirectory) process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

function withDataDirectorySync<T>(dataDirectory: string | undefined, action: () => T): T {
  const previous = process.env.REPOMIND_DATA_DIR;
  if (dataDirectory) process.env.REPOMIND_DATA_DIR = dataDirectory;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

export async function startHostLifecycle(
  repository: string,
  task: string,
  dataDirectory?: string,
  maxMemories = 5,
): Promise<HostLifecycleStart> {
  const started = performance.now();
  const result = await withDataDirectory(dataDirectory, async () => {
    const core = new RepositoryMemoryCore(repository);
    try {
      return await core.startSessionHybrid({ task, clientName: "opencode-host", maxMemories });
    } finally {
      core.close();
    }
  });
  return { sessionId: result.sessionId, startMs: round(performance.now() - started), result };
}

export function commitHostLifecycle(input: {
  repository: string;
  dataDirectory?: string;
  sessionId: string;
  idempotencyKey: string;
  status: "success" | "partial" | "failed";
  summary: string;
  tests?: TestEvidenceInput[];
  commands?: TestEvidenceInput[];
}): HostLifecycleCommit {
  const started = performance.now();
  const result = withDataDirectorySync(input.dataDirectory, () => {
    const core = new RepositoryMemoryCore(input.repository);
    try {
      return core.commitSession({
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        summary: input.summary,
        ...(input.tests?.length ? { tests: input.tests } : {}),
        ...(input.commands?.length ? { commands: input.commands } : {}),
      });
    } finally {
      core.close();
    }
  });
  return { commitMs: round(performance.now() - started), result };
}

export function abandonHostLifecycle(
  repository: string,
  sessionId: string,
  dataDirectory?: string,
): HostLifecycleAbandon {
  const started = performance.now();
  withDataDirectorySync(dataDirectory, () => {
    const core = new RepositoryMemoryCore(repository);
    try {
      core.abandonSession(sessionId);
    } finally {
      core.close();
    }
  });
  return { abandonMs: round(performance.now() - started) };
}

function renderMemory(memory: MemoryResult, index: number): string {
  const warning = memory.warning ? `\nWarning: ${memory.warning}` : "";
  return `[${index + 1}] ${memory.type} / ${memory.status} / ${memory.id}\n${memory.title}\n${memory.content}${warning}`;
}

export function hostManagedPrompt(task: string, memories: MemoryResult[]): string {
  const context = memories.length
    ? memories.map(renderMemory).join("\n\n")
    : "No matching repository memories were retrieved.";
  return `RepoMind lifecycle is managed by the host. Do not call RepoMind session or memory tools.\n\nThe host retrieved the following evidence-backed repository memories. Treat stale or uncertain entries cautiously and verify them against the current repository.\n\n${context}\n\nCurrent task:\n${task}`;
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(test|tests|vitest|jest|pytest|unittest|mocha)(\s|$)|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/iu.test(command);
}

export function analyzeOpenCodeOutcome(jsonl: string, fallbackSummary: string): OpenCodeOutcome {
  let summary = "";
  const commands: OpenCodeCommandEvidence[] = [];
  for (const line of jsonl.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "text" && typeof part?.text === "string" && part.text.trim()) summary = part.text.trim();
    if (event.type !== "tool_use" || (part?.tool !== "bash" && part?.tool !== "shell")) continue;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const input = state.input as Record<string, unknown> | undefined;
    const metadata = state.metadata as Record<string, unknown> | undefined;
    if (typeof input?.command !== "string" || !input.command.trim()) continue;
    const output = typeof state.output === "string" ? state.output.trim() : "";
    commands.push({
      command: input.command.trim(),
      exitCode: Number.isInteger(metadata?.exit) ? Number(metadata?.exit) : state.status === "completed" ? 0 : 1,
      summary: output.slice(0, 2000),
      isTest: isTestCommand(input.command),
    });
  }
  return { summary: summary || fallbackSummary, commands };
}
