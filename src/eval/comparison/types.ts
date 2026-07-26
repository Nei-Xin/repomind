import type { RepositoryMemoryCore } from "../../core.js";
import type { Fixture } from "./fixture.js";
import type { RawCorpus } from "./corpus.js";

export type ArmKey =
  | "oracle-ceiling"
  | "no-memory"
  | "full-history"
  | "flat-lexical-rag"
  | "recency-k"
  | "repomind-nogov"
  | "repomind"
  | "flat-vector-rag"
  | "repomind-layered-hybrid";

/** What a record is, for the per-kind character breakdown that lets a reader
 * re-derive token counts with a real tokenizer (caveat 4). */
export type RecordKind =
  | "repo_base"
  | "repo_chunk"
  | "session"
  | "memory"
  | "gold";

export interface ContextRecord {
  kind: RecordKind;
  /** Rendered text as it would reach an agent's context. */
  text: string;
  /** Present when the record came from a memory, used for one-sided metrics. */
  memoryId?: string;
  memoryStatus?: string;
  /** True when the record carries a stale or conflict warning. */
  warned?: boolean;
  /** True when the record resolves to at least one evidence row. */
  hasEvidence?: boolean;
  /** Retrieval rank within the arm, 1-based; absent for unranked arms. */
  rank?: number;
}

export interface ContextBundle {
  arm: ArmKey;
  records: ContextRecord[];
  chars: number;
  charsByKind: Record<string, number>;
  repoTokens: number;
  memoryTokens: number;
  approxTokens: number;
  truncated: boolean;
  capBound: boolean;
  /** Set by the flat-RAG arm when a recency weight was swept. */
  alpha?: number;
}

export interface ArmContext {
  fixture: Fixture;
  corpus: RawCorpus;
  core: RepositoryMemoryCore;
  repositoryPath: string;
  /** Shared base every arm receives, so deltas are attributable to memory. */
  repoBase: ContextRecord[];
  /** Repository contents at the end of replay, for the repo-file retriever. */
  repoFiles: Map<string, string>;
  budget: number;
}

export interface Arm {
  key: ArmKey;
  description: string;
  /** False for arms whose mechanism the product does not have yet. */
  available: boolean;
  status: "run" | "unavailable" | "not-implemented";
  reason?: string;
  /** Reference arms normalize the scale but never enter the win/loss ledger. */
  reference?: boolean;
  assemble(context: ArmContext): ContextBundle;
}

export type MeasurementClass = "comparative" | "one-sided" | "definitional" | "proxy";

export interface MetricDefinition {
  key: string;
  measurementClass: MeasurementClass;
  formula: string;
  specRef: string | null;
}
