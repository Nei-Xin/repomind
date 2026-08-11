import type { TestEvidenceInput } from "../../domain/types.js";
import {
  runAgentHost,
  summarizeDerivedMaintenance,
  type AgentHostRunReport,
  type HostRunMaintenanceReport,
  type HostRunMaintenanceStage,
  type HostVerificationResult,
} from "../agent-host/run.js";
import { executeAgentProcess } from "../agent-host/process.js";
import type {
  AgentProcessExecutor,
  AgentProcessRequest,
  AgentProcessResult,
} from "../agent-host/types.js";
import {
  createOpenCodeHostAdapter,
  hostManagedOpenCodeConfig,
  resolveOpenCodeExecutable,
} from "./adapter.js";

export type OpenCodeProcessRequest = AgentProcessRequest;
export type OpenCodeProcessResult = AgentProcessResult;
export type OpenCodeProcessExecutor = AgentProcessExecutor;
export type HostRunReport = AgentHostRunReport<"opencode">;

export interface RunOpenCodeHostOptions {
  repository: string;
  task: string;
  runnerExecutable?: string;
  model?: string;
  maxMemories?: number;
  contextBudgetChars?: number;
  timeoutMs?: number;
  outputDirectory?: string;
  dataDirectory?: string;
  signal?: AbortSignal;
  execute?: OpenCodeProcessExecutor;
  onStatus?: (message: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxAgentAttempts?: number;
  retryDelayMs?: number;
  retryWait?: (delayMs: number) => void | Promise<void>;
  /** Host-owned checks run after the Agent and before commit. */
  verify?: (
    repository: string,
  ) => readonly TestEvidenceInput[] | HostVerificationResult
    | Promise<readonly TestEvidenceInput[] | HostVerificationResult>;
  /** Identifies who owns the authoritative verification policy in telemetry. */
  verificationAuthority?: "host-config" | "benchmark-manifest";
}

export {
  hostManagedOpenCodeConfig,
  resolveOpenCodeExecutable,
  summarizeDerivedMaintenance,
  type HostRunMaintenanceReport,
  type HostRunMaintenanceStage,
  type HostVerificationResult,
};

export const executeOpenCodeProcess: OpenCodeProcessExecutor = executeAgentProcess;

export async function runOpenCodeHost(options: RunOpenCodeHostOptions): Promise<HostRunReport> {
  const {
    runnerExecutable,
    execute,
    repository,
    task,
    model,
    maxMemories,
    contextBudgetChars,
    timeoutMs,
    outputDirectory,
    dataDirectory,
    signal,
    onStatus,
    onStdout,
    onStderr,
    maxAgentAttempts,
    retryDelayMs,
    retryWait,
    verify,
    verificationAuthority,
  } = options;
  const adapter = createOpenCodeHostAdapter({
    ...(runnerExecutable === undefined ? {} : { executable: runnerExecutable }),
    ...(execute === undefined ? {} : { execute }),
  });
  return runAgentHost({
    adapter,
    repository,
    task,
    ...(model === undefined ? {} : { model }),
    ...(maxMemories === undefined ? {} : { maxMemories }),
    ...(contextBudgetChars === undefined ? {} : { contextBudgetChars }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(signal === undefined ? {} : { signal }),
    ...(onStatus === undefined ? {} : { onStatus }),
    ...(onStdout === undefined ? {} : { onStdout }),
    ...(onStderr === undefined ? {} : { onStderr }),
    ...(maxAgentAttempts === undefined ? {} : { maxAgentAttempts }),
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(retryWait === undefined ? {} : { retryWait }),
    ...(verify === undefined ? {} : { verify }),
    ...(verificationAuthority === undefined ? {} : { verificationAuthority }),
  });
}
