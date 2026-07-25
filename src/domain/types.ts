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
  | "manual";

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
  memories: { stored: number; skipped: number };
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
