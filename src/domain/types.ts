export type SessionStatus = "open" | "committed" | "partial" | "failed" | "abandoned";
export type MemoryStatus = "active" | "uncertain" | "superseded" | "invalid";
export type MemoryType =
  | "architecture"
  | "convention"
  | "decision"
  | "command"
  | "failure"
  | "solution"
  | "dependency"
  | "location"
  | "requirement"
  | "risk";

export type EvidenceKind =
  | "user_requirement"
  | "agent_summary"
  | "git_snapshot"
  | "git_diff"
  | "file_snapshot"
  | "test_result"
  | "command_result"
  | "commit"
  | "manual"
  | "validation"
  | "correction"
  | "invalidation";

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  status: string;
}

export interface MemoryResult {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  confidence: number;
  status: MemoryStatus;
  scopeType: "repository" | "module" | "path";
  scopeValue: string | null;
  tags: string[];
  score: number;
  warning?: string;
  staleReasons?: StaleReason[];
}

export interface HybridSearchResult {
  strategy: "hybrid-fts5-vector" | "fts5-with-substring-fallback";
  memories: MemoryResult[];
  fallbackReason?: string;
}

export interface StaleReason {
  kind: "file_created" | "file_modified" | "file_deleted";
  filePath: string;
  expectedHash: string | null;
  currentHash: string | null;
}

export type MemoryStatusReason =
  | { kind: "stale_files"; files: StaleReason[] }
  | { kind: "conflict"; withMemoryIds: string[] }
  | { kind: "superseded"; replacementMemoryId: string; reason: string }
  | { kind: "invalid"; reason: string };

export interface ValidateMemoryInput {
  memoryId: string;
  reason: string;
}

export interface ValidateMemoryResult {
  memoryId: string;
  status: "active";
  lastValidatedAt: number;
  files: Array<{ filePath: string; fileHash: string | null }>;
}

export interface CorrectMemoryInput {
  memoryId: string;
  reason: string;
  title: string;
  content: string;
  type?: MemoryType;
  confidence?: number;
  tags?: string[];
  relatedFiles?: string[];
}

export interface CorrectMemoryResult {
  memoryId: string;
  status: "superseded";
  replacementMemoryId: string;
  replacementStored: boolean;
  /** Live memories the replacement still contradicts; each is left uncertain. */
  conflicts: string[];
}

export interface InvalidateMemoryInput {
  memoryId: string;
  reason: string;
}

export interface InvalidateMemoryResult {
  memoryId: string;
  status: "invalid";
}

export type ForgetScope = "memory" | "memory-and-evidence";

export interface ForgetMemoryInput {
  memoryId: string;
  reason: string;
  scope?: ForgetScope;
}

export interface ForgetMemoryResult {
  memoryId: string;
  scope: ForgetScope;
  evidenceDeleted: number;
}

export interface StartSessionInput {
  task: string;
  clientName?: string;
  clientSessionId?: string;
  maxMemories?: number;
}

export interface StartSessionResult {
  sessionId: string;
  repositoryId: string;
  baseline: GitSnapshot;
  memories: MemoryResult[];
  retrievalStrategy?: HybridSearchResult["strategy"];
  retrievalFallbackReason?: string;
}

export interface TestEvidenceInput {
  command: string;
  exitCode: number;
  summary: string;
}

export interface CommitSessionInput {
  sessionId: string;
  idempotencyKey: string;
  status: "success" | "partial" | "failed";
  summary: string;
  decisions?: string[];
  tests?: TestEvidenceInput[];
  commands?: Array<{ command: string; exitCode: number; summary: string }>;
  remainingWork?: string[];
}

export interface CommitSessionResult {
  sessionId: string;
  status: SessionStatus;
  evidenceCreated: number;
  memories: { stored: number; skipped: number; conflicts: number };
}

export type HostRunStatus = "running" | SessionStatus;

export interface HostRunRecord {
  id: string;
  sessionId: string;
  task: string;
  runner: string;
  model: string | null;
  outputDirectory: string;
  reportPath: string | null;
  status: HostRunStatus;
  agentExitCode: number | null;
  agentSignal: string | null;
  retrievedMemories: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  repoMindCalls: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
}

export interface BeginHostRunInput {
  sessionId: string;
  task: string;
  runner: string;
  model?: string;
  outputDirectory: string;
  retrievedMemories: number;
  startedAt?: number;
}

export interface FinishHostRunInput {
  runId: string;
  status: Exclude<HostRunStatus, "running">;
  reportPath?: string;
  agentExitCode?: number | null;
  agentSignal?: string | null;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  repoMindCalls?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  endedAt?: number;
}

export interface RecordMemoryInput {
  type: MemoryType;
  title: string;
  content: string;
  confidence?: number;
  scopeType?: "repository" | "module" | "path";
  scopeValue?: string;
  tags?: string[];
  relatedFiles?: string[];
}
