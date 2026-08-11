import type { AgentEventMetrics } from "../../eval/agent/events.js";
import { parseAgentEvents } from "../../eval/agent/events.js";
import type { AgentCommandEvidence, AgentOutcome } from "../agent-host/types.js";

const MAX_HOST_SUMMARY_CHARS = 12_000;
const MAX_COMMAND_SUMMARY_CHARS = 2_000;
const SUMMARY_TRUNCATION_MARKER = "\n[truncated by RepoMind host]";

type JsonObject = Record<string, unknown>;

interface ClaudeToolUse {
  id: string | null;
  name: string;
  input: JsonObject;
}

interface ClaudeToolResult {
  id: string;
  content: string;
  isError: boolean | null;
  invalidErrorFlag: boolean;
  metadata: JsonObject;
}

interface ToolResultStatus {
  known: boolean;
  exitCode: number;
}

export interface ClaudeEventAnalysis {
  outcome: AgentOutcome;
  metrics: AgentEventMetrics;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function boundedSummary(value: string): string {
  const sanitized = value.replace(/\u0000/gu, "");
  if (sanitized.length <= MAX_HOST_SUMMARY_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_HOST_SUMMARY_CHARS - SUMMARY_TRUNCATION_MARKER.length).trimEnd()}${SUMMARY_TRUNCATION_MARKER}`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return arrayValue(value)
    .map((item) => nonEmptyString(objectValue(item).text) ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isCommandTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "bash" || normalized === "powershell";
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(test|tests|vitest|jest|pytest|unittest|mocha)(\s|$)|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/iu.test(command);
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function metadataExitCode(result: ClaudeToolResult): number | null {
  for (const source of [result.metadata, objectValue(result.metadata.result)]) {
    for (const field of ["exitCode", "exit_code", "code"]) {
      const value = integerValue(source[field]);
      if (value !== null) return value;
    }
  }
  return null;
}

function contentExitCode(result: ClaudeToolResult): number | null {
  const match = /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/iu.exec(result.content);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function pairedResultStatus(results: readonly ClaudeToolResult[]): ToolResultStatus {
  if (results.length !== 1) return { known: false, exitCode: 1 };
  const result = results[0]!;
  if (result.invalidErrorFlag) return { known: false, exitCode: 1 };
  const explicitMetadata = metadataExitCode(result);
  const errorSignaled = result.isError === true || result.metadata.interrupted === true;
  if (errorSignaled) {
    const explicitFailure = explicitMetadata ?? contentExitCode(result);
    if (explicitFailure === 0) return { known: false, exitCode: 1 };
    return { known: true, exitCode: explicitFailure ?? 1 };
  }
  if (result.isError === false && explicitMetadata !== null && explicitMetadata !== 0) {
    return { known: false, exitCode: 1 };
  }
  if (explicitMetadata !== null) return { known: true, exitCode: explicitMetadata };
  return { known: true, exitCode: 0 };
}

function resultSummary(result: ClaudeToolResult | undefined): string {
  if (!result) return "No matching Claude tool_result was observed.";
  const stdout = nonEmptyString(result.metadata.stdout);
  const stderr = nonEmptyString(result.metadata.stderr);
  return [result.content, stdout, stderr].filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n")
    .slice(0, MAX_COMMAND_SUMMARY_CHARS);
}

function memoriesIn(value: unknown, depth = 0): number {
  if (depth > 4) return 0;
  if (typeof value === "string") {
    try { return memoriesIn(JSON.parse(value) as unknown, depth + 1); } catch { return 0; }
  }
  if (Array.isArray(value)) return Math.max(0, ...value.map((item) => memoriesIn(item, depth + 1)));
  const object = objectValue(value);
  if (Array.isArray(object.memories)) return object.memories.length;
  return Math.max(0, ...Object.values(object).map((item) => memoriesIn(item, depth + 1)));
}

function terminalIsError(event: JsonObject): boolean {
  return event.is_error === true
    || (typeof event.terminal_reason === "string" && event.terminal_reason !== "completed")
    || (event.api_error_status !== null && event.api_error_status !== undefined);
}

export function analyzeClaudeEvents(jsonl: string, fallbackSummary: string): ClaudeEventAnalysis {
  const { events, malformedLines } = parseAgentEvents(jsonl);
  const toolUses: ClaudeToolUse[] = [];
  const resultsById = new Map<string, ClaudeToolResult[]>();
  const toolCalls = new Map<string, number>();
  const reads = new Map<string, number>();
  const terminalResults: JsonObject[] = [];
  let assistantSummary = "";
  let explicitErrors = 0;
  let malformedCommandUses = 0;

  for (const event of events) {
    if (event.type === "error") explicitErrors += 1;
    if (event.type === "result") {
      terminalResults.push(event);
      if (terminalIsError(event)) explicitErrors += 1;
    }
    if (event.type === "assistant") {
      if (event.is_api_error_message === true || typeof event.error === "string") explicitErrors += 1;
      const message = objectValue(event.message);
      const text = contentText(message.content);
      if (text) assistantSummary = text;
      for (const rawBlock of arrayValue(message.content)) {
        const block = objectValue(rawBlock);
        if (block.type !== "tool_use") continue;
        const name = nonEmptyString(block.name);
        if (!name) continue;
        const id = nonEmptyString(block.id);
        const input = objectValue(block.input);
        const use = { id, name, input };
        toolUses.push(use);
        toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        if (isCommandTool(name) && !nonEmptyString(input.command)) malformedCommandUses += 1;
      }
    }
    if (event.type !== "user") continue;
    const message = objectValue(event.message);
    const blocks = arrayValue(message.content).map(objectValue).filter((block) => block.type === "tool_result");
    const sharedMetadata = blocks.length === 1 ? objectValue(event.tool_use_result) : {};
    for (const block of blocks) {
      const id = nonEmptyString(block.tool_use_id);
      if (!id) continue;
      const rawErrorFlag = block.is_error;
      const result: ClaudeToolResult = {
        id,
        content: contentText(block.content),
        isError: typeof rawErrorFlag === "boolean" ? rawErrorFlag : null,
        invalidErrorFlag: rawErrorFlag !== undefined && typeof rawErrorFlag !== "boolean",
        metadata: sharedMetadata,
      };
      resultsById.set(id, [...(resultsById.get(id) ?? []), result]);
    }
  }

  const usesById = new Map<string, ClaudeToolUse[]>();
  for (const use of toolUses) {
    if (use.id) usesById.set(use.id, [...(usesById.get(use.id) ?? []), use]);
  }

  const commands: AgentCommandEvidence[] = [];
  for (const use of toolUses) {
    if (!isCommandTool(use.name)) continue;
    const command = nonEmptyString(use.input.command);
    if (!command) continue;
    const uniquelyIdentified = use.id !== null && usesById.get(use.id)?.length === 1;
    const results = uniquelyIdentified ? resultsById.get(use.id!) ?? [] : [];
    const status = pairedResultStatus(results);
    commands.push({
      command,
      exitCode: status.exitCode,
      exitCodeKnown: status.known,
      isTest: isTestCommand(command),
      summary: resultSummary(results.length === 1 ? results[0] : undefined),
    });
  }

  let failedTools = 0;
  let failedFileReads = 0;
  for (const use of toolUses) {
    const uniquelyIdentified = use.id !== null && usesById.get(use.id)?.length === 1;
    const results = uniquelyIdentified ? resultsById.get(use.id!) ?? [] : [];
    const status = pairedResultStatus(results);
    const result = results.length === 1 ? results[0] : undefined;
    const failed = result?.isError === true
      || result?.metadata.interrupted === true
      || (status.known && status.exitCode !== 0);
    if (uniquelyIdentified && failed) failedTools += 1;
    if (use.name.toLowerCase() !== "read") continue;
    const readPath = nonEmptyString(use.input.file_path) ?? nonEmptyString(use.input.filePath);
    if (!uniquelyIdentified || result === undefined || failed || !readPath) failedFileReads += 1;
    else reads.set(readPath.toLowerCase(), (reads.get(readPath.toLowerCase()) ?? 0) + 1);
  }

  let retrievedMemories = 0;
  for (const use of toolUses) {
    if (!use.id || !use.name.toLowerCase().startsWith("mcp__repomind__repo_session_start")) continue;
    const results = resultsById.get(use.id) ?? [];
    if (results.length === 1) retrievedMemories = Math.max(retrievedMemories, memoriesIn(results[0]!.content));
  }

  const terminalResult = terminalResults.at(-1);
  const terminalClean = terminalResults.length === 1
    && events.at(-1) === terminalResult
    && terminalResult?.is_error === false
    && terminalResult.terminal_reason === "completed";
  const terminal = explicitErrors > 0
    ? "explicit-error" as const
    : terminalClean
      ? "clean-stop" as const
      : "incomplete" as const;
  const unknownCommandResults = malformedCommandUses + commands.filter((command) => !command.exitCodeKnown).length;
  const terminalUsage = objectValue(terminalResult?.usage);
  const terminalSummary = nonEmptyString(terminalResult?.result);
  const turns = terminalResult ? Math.floor(nonNegativeNumber(terminalResult.num_turns)) : 0;
  const repoMindCalls = [...toolCalls]
    .filter(([name]) => name.toLowerCase().startsWith("mcp__repomind__"))
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    outcome: {
      summary: boundedSummary(terminalSummary ?? (assistantSummary || fallbackSummary)),
      commands,
      trace: {
        parsedEvents: events.length,
        malformedLines,
        explicitErrors,
        unknownCommandResults,
        terminal,
      },
    },
    metrics: {
      turns,
      tokens: {
        input: nonNegativeNumber(terminalUsage.input_tokens),
        output: nonNegativeNumber(terminalUsage.output_tokens),
        reasoning: nonNegativeNumber(terminalUsage.reasoning_tokens),
        cacheRead: nonNegativeNumber(terminalUsage.cache_read_input_tokens),
        cacheWrite: nonNegativeNumber(terminalUsage.cache_creation_input_tokens),
      },
      toolCalls: Object.fromEntries([...toolCalls].sort(([a], [b]) => a.localeCompare(b))),
      failedTools,
      failedCommands: commands.filter((command) => command.exitCode !== 0).length,
      fileReads: [...reads.values()].reduce((sum, count) => sum + count, 0),
      failedFileReads,
      repeatedFileReads: [...reads.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      repoMindCalls,
      retrievedMemories,
    },
  };
}
