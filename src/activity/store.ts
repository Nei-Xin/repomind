import { createHash, randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { RepositoryMemoryCore } from "../core.js";
import type {
  CommitSessionResult,
  DerivedMemoryMaintenanceResult,
  TestEvidenceInput,
} from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import type {
  AbortInteractiveTaskRequest,
  CodingAgent,
  FinishInteractiveTaskRequest,
  RecordActivityRequest,
  RecallInteractiveContextRequest,
  RegisterAgentSessionRequest,
  StartInteractiveTaskRequest,
} from "../protocol/activity.js";
import { redactDeep } from "../security/redaction.js";
import { renderInteractiveRecall, type InteractiveRecallRecord } from "./context.js";
import { verificationSteps, verifyingTestCommand } from "./test-command.js";

type SqlValue = string | number | null;

interface AgentSessionRow {
  id: string;
  current_session_id: string | null;
  last_session_id: string | null;
  current_task_event_id: string | null;
  status: string;
}

interface ActivityRow {
  id: string;
  session_id: string | null;
  event_type: string;
  payload_json: string;
  occurred_at: number;
}

export interface InteractiveTaskStartResult {
  agentSessionId: string;
  sessionId: string;
  repositoryId: string;
  recalled: { memories: number; modules: number; profile: boolean };
  context: string;
  resumed: boolean;
}

export interface ActivityRecordResult {
  eventId: string;
  sessionId: string | null;
  stored: boolean;
  redactions: number;
}

export interface InteractiveTaskFinishResult {
  sessionId: string;
  status: CommitSessionResult["status"];
  evidenceCreated: number;
  memories: CommitSessionResult["memories"];
  activities: number;
  commands: number;
  tests: number;
  maintenance: DerivedMemoryMaintenanceResult | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function agentSessionId(repositoryId: string, agent: string, externalId: string): string {
  return `ags_${hash(`${repositoryId}\0${agent}\0${externalId}`).slice(0, 32)}`;
}

function interactiveClientName(agent: CodingAgent): string {
  return `${agent}-interactive`;
}

function interactiveActivitySource(agent: CodingAgent): "claude-hook" | "opencode-plugin" {
  return agent === "claude" ? "claude-hook" : "opencode-plugin";
}

function agentDisplayName(agent: CodingAgent): string {
  return agent === "claude" ? "Claude" : "OpenCode";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function commandExitCode(eventType: string, response: unknown): number | null {
  if (eventType === "tool_failure") return 1;
  const payload = objectValue(response);
  for (const source of [payload, objectValue(payload.result), objectValue(payload.metadata)]) {
    for (const field of ["exitCode", "exit_code", "exit", "code"]) {
      const value = integerValue(source[field]);
      if (value !== null) return value;
    }
  }
  if (typeof response === "string") {
    const match = /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/iu.exec(response);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  // A completed tool invocation does not establish the command's exit code.
  return null;
}

function boundedSummary(value: unknown): string {
  const text = typeof value === "string" ? value : stableJson(value);
  return text.replace(/\u0000/gu, "").slice(0, 2_000);
}

function commandEvidence(rows: readonly ActivityRow[]): Array<Omit<TestEvidenceInput, "exitCode"> & { exitCode: number | null; isTest: boolean }> {
  const commands: ReturnType<typeof commandEvidence> = [];
  for (const row of rows) {
    if (row.event_type !== "tool_result" && row.event_type !== "tool_failure") continue;
    const payload = objectValue(JSON.parse(row.payload_json) as unknown);
    const toolName = String(payload.toolName ?? payload.tool_name ?? "").toLowerCase();
    if (toolName !== "bash" && toolName !== "powershell" && toolName !== "shell") continue;
    const input = objectValue(payload.toolInput ?? payload.tool_input);
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) continue;
    const response = payload.toolResponse ?? payload.tool_response ?? payload.error ?? "";
    const testCommand = verifyingTestCommand(command);
    commands.push({
      command: testCommand ?? command,
      ...(testCommand !== null && testCommand !== command ? { invokedAs: command } : {}),
      // An exit status in the tool response wins; otherwise use what the
      // agent integration observed from its own event semantics.
      exitCode: commandExitCode(row.event_type, response)
        ?? (row.event_type === "tool_result" ? integerValue(payload.observedExitCode) : null),
      summary: boundedSummary(response),
      isTest: testCommand !== null,
    });
  }
  return commands;
}

/**
 * A task is incomplete only when a verification step (test, build, type-check,
 * lint) did not end in a pass: the latest run of each step decides, so a fix
 * followed by a passing re-run completes the task. Failed exploratory commands
 * (`ls`, `cat`, `grep`) stay in the Evidence without downgrading the task.
 */
function hasUnresolvedVerification(commands: ReturnType<typeof commandEvidence>): boolean {
  const latest = new Map<string, boolean>();
  for (const command of commands) {
    for (const step of verificationSteps(command.invokedAs ?? command.command, command.exitCode)) {
      latest.set(step.key, step.passed);
    }
  }
  return [...latest.values()].some((passed) => !passed);
}

export class InteractiveActivityStore {
  readonly core: RepositoryMemoryCore;

  constructor(repositoryPath: string, dataDirectory?: string) {
    this.core = new RepositoryMemoryCore(repositoryPath, dataDirectory === undefined ? {} : { dataDirectory });
  }

  close(): void {
    this.core.close();
  }

  register(input: RegisterAgentSessionRequest): { agentSessionId: string; repositoryId: string } {
    const now = input.timestamp ?? Date.now();
    const repositoryId = this.core.context.marker.projectId;
    const id = agentSessionId(repositoryId, input.agent, input.agentSessionId);
    this.core.context.database.raw.prepare(`
      INSERT INTO agent_sessions(id, repository_id, checkout_id, agent, external_session_id, status,
        started_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(repository_id, agent, external_session_id) DO UPDATE SET
        checkout_id=excluded.checkout_id, status='active', last_seen_at=excluded.last_seen_at, ended_at=NULL
    `).run(
      id,
      repositoryId,
      this.core.context.checkoutId,
      input.agent,
      input.agentSessionId,
      now,
      now,
    );
    return { agentSessionId: id, repositoryId };
  }

  startTask(input: StartInteractiveTaskRequest): InteractiveTaskStartResult {
    return this.core.context.database.transaction(() => this.startTaskInTransaction(input));
  }

  private startTaskInTransaction(input: StartInteractiveTaskRequest): InteractiveTaskStartResult {
    const registered = this.register(input);
    const row = this.agentSession(input.agent, input.agentSessionId);
    const prior = this.core.context.database.raw.prepare(
      "SELECT session_id, agent_session_id, payload_json FROM activity_events WHERE id=? AND repository_id=?",
    ).get(`activity:${input.eventId}`, this.core.context.marker.projectId) as {
      session_id: string; agent_session_id: string; payload_json: string;
    } | undefined;
    if (prior) {
      const payload = objectValue(JSON.parse(prior.payload_json));
      if (prior.agent_session_id !== registered.agentSessionId || payload.text !== redactDeep(input.task).value
        || (payload.maxMemories !== undefined && payload.maxMemories !== (input.maxMemories ?? 5))) {
        throw new RepoMindError("INVALID_INPUT", "Task start event was reused with different input");
      }
      if (row.current_session_id !== prior.session_id) {
        throw new RepoMindError("SESSION_NOT_OPEN", "This task start event belongs to a completed or superseded task");
      }
      return this.renderStartResult(input, prior.session_id, true);
    }
    if (row.current_session_id) {
      this.core.commitSession({
        sessionId: row.current_session_id,
        idempotencyKey: `interactive:superseded:${input.eventId}`,
        status: "partial",
        summary: "The interactive task was superseded by a new user prompt before a final event was observed.",
        remainingWork: ["Review the previous task before treating its result as complete."],
      });
    }

    const started = this.core.startSession({
      task: input.task,
      clientName: interactiveClientName(input.agent),
      clientSessionId: input.agentSessionId,
      maxMemories: input.maxMemories ?? 5,
    });
    const { context, recall } = renderInteractiveRecall(started.memories, started.moduleNarratives, started.repositoryProfile);
    this.core.context.database.transaction(() => {
      this.core.context.database.raw.prepare(`
        UPDATE agent_sessions SET current_session_id=?, current_task_event_id=?, status='active',
          last_seen_at=?, ended_at=NULL WHERE id=?
      `).run(started.sessionId, input.eventId, input.timestamp ?? Date.now(), registered.agentSessionId);
      this.insertActivity(registered.agentSessionId, started.sessionId, {
        schemaVersion: 1,
        eventId: `activity:${input.eventId}`,
        agent: input.agent,
        agentSessionId: input.agentSessionId,
        repositoryPath: input.repositoryPath,
        source: interactiveActivitySource(input.agent),
        type: "user_message",
        timestamp: input.timestamp,
        payload: { text: input.task, taskStartEventId: input.eventId, maxMemories: input.maxMemories ?? 5, recall },
      });
    });
    return {
      agentSessionId: input.agentSessionId,
      sessionId: started.sessionId,
      repositoryId: started.repositoryId,
      recalled: {
        memories: recall.memoryIds.length,
        modules: recall.moduleIds.length,
        profile: recall.profileId !== null,
      },
      context,
      resumed: false,
    };
  }

  record(input: RecordActivityRequest): ActivityRecordResult {
    const row = this.agentSession(input.agent, input.agentSessionId);
    const sessionId = row.current_session_id ?? (input.source === "memory-proxy" ? row.last_session_id : null);
    const result = this.insertActivity(row.id, sessionId, input);
    this.touch(row.id, input.timestamp ?? Date.now());
    return result;
  }

  finish(input: FinishInteractiveTaskRequest): InteractiveTaskFinishResult {
    const registered = this.register(input);
    const current = this.agentSession(input.agent, input.agentSessionId);
    const prior = this.core.context.database.raw.prepare(
      "SELECT session_id FROM activity_events WHERE id=? AND repository_id=?",
    ).get(input.eventId, this.core.context.marker.projectId) as { session_id: string | null } | undefined;
    const sessionId = current.current_session_id ?? prior?.session_id ?? null;
    if (!sessionId) {
      throw new RepoMindError(
        "SESSION_NOT_OPEN",
        `${agentDisplayName(input.agent)} session ${input.agentSessionId} has no active task`,
      );
    }

    this.insertActivity(registered.agentSessionId, sessionId, {
      schemaVersion: 1,
      eventId: input.eventId,
      agent: input.agent,
      agentSessionId: input.agentSessionId,
      repositoryPath: input.repositoryPath,
      source: interactiveActivitySource(input.agent),
      type: "session_event",
      timestamp: input.timestamp,
      payload: { kind: "task_finish", summary: input.summary, requestedStatus: input.status ?? null },
    });
    const activities = this.activitiesForSession(sessionId);
    const observed = commandEvidence(activities);
    const requestedStatus = input.status ?? "success";
    const status = requestedStatus === "success" && hasUnresolvedVerification(observed)
      ? "partial"
      : requestedStatus;
    // Unknown results remain in L0 activity; only known exits become command/test evidence.
    const knownResults = observed.filter((command): command is TestEvidenceInput & { isTest: boolean } => command.exitCode !== null);
    const summary = input.summary.trim()
      || `${agentDisplayName(input.agent)} completed the interactive task without a textual final summary.`;
    const result = this.core.commitSession({
      sessionId,
      idempotencyKey: `interactive:${input.eventId}`,
      status,
      summary,
      tests: knownResults.filter((command) => command.isTest).map(({ isTest: _isTest, ...command }) => command),
      commands: knownResults.filter((command) => !command.isTest).map(({ isTest: _isTest, ...command }) => command),
      ...(status === "success" ? {} : { remainingWork: ["Review failed or incomplete command activity before relying on this task."] }),
    }, { tests: "tool-observed", commands: "tool-observed", solutionPolicy: "repository-outcome" });
    const maintenance = result.status === "committed"
      ? this.core.maintainMemoryLayers()
      : null;
    this.core.context.database.raw.prepare(`
      UPDATE agent_sessions SET current_session_id=NULL, last_session_id=?, current_task_event_id=NULL,
        last_seen_at=? WHERE id=?
    `).run(sessionId, input.timestamp ?? Date.now(), registered.agentSessionId);
    return {
      sessionId,
      status: result.status,
      evidenceCreated: result.evidenceCreated,
      memories: result.memories,
      activities: activities.length,
      commands: observed.filter((command) => !command.isTest).length,
      tests: observed.filter((command) => command.isTest).length,
      maintenance,
    };
  }

  abort(input: AbortInteractiveTaskRequest): { sessionId: string | null; status: "abandoned" | "idle" } {
    const registered = this.register(input);
    const current = this.agentSession(input.agent, input.agentSessionId);
    if (!current.current_session_id) {
      this.endAgentSession(registered.agentSessionId, input.timestamp ?? Date.now());
      return { sessionId: null, status: "idle" };
    }
    this.insertActivity(registered.agentSessionId, current.current_session_id, {
      schemaVersion: 1,
      eventId: input.eventId,
      agent: input.agent,
      agentSessionId: input.agentSessionId,
      repositoryPath: input.repositoryPath,
      source: interactiveActivitySource(input.agent),
      type: "session_event",
      timestamp: input.timestamp,
      payload: { kind: "task_abort", reason: input.reason },
    });
    this.core.abandonSession(current.current_session_id);
    this.endAgentSession(registered.agentSessionId, input.timestamp ?? Date.now());
    return { sessionId: current.current_session_id, status: "abandoned" };
  }

  recall(input: RecallInteractiveContextRequest): {
    repositoryId: string;
    recalled: { memories: number; modules: number; profile: boolean };
    context: string;
  } {
    this.register(input);
    const memories = input.maxMemories === 0
      ? []
      : this.core.search(input.query, { limit: input.maxMemories ?? 5 });
    const modules = this.core.searchModuleNarratives(input.query);
    const profile = this.core.getRepositoryProfile() ?? undefined;
    const { context, recall } = renderInteractiveRecall(memories, modules, profile);
    this.recordRecall(input, recall);
    return {
      repositoryId: this.core.context.marker.projectId,
      recalled: { memories: recall.memoryIds.length, modules: recall.moduleIds.length, profile: recall.profileId !== null },
      context,
    };
  }

  private renderStartResult(
    input: StartInteractiveTaskRequest,
    sessionId: string,
    resumed: boolean,
  ): InteractiveTaskStartResult {
    const memories = input.maxMemories === 0
      ? []
      : this.core.search(input.task, { limit: input.maxMemories ?? 5 });
    const modules = this.core.searchModuleNarratives(input.task);
    const profile = this.core.getRepositoryProfile() ?? undefined;
    const { context, recall } = renderInteractiveRecall(memories, modules, profile);
    this.recordRecall(input, recall);
    return {
      agentSessionId: input.agentSessionId,
      sessionId,
      repositoryId: this.core.context.marker.projectId,
      recalled: { memories: recall.memoryIds.length, modules: recall.moduleIds.length, profile: recall.profileId !== null },
      context,
      resumed,
    };
  }

  private recordRecall(
    input: Pick<RecallInteractiveContextRequest, "agent" | "agentSessionId" | "repositoryPath">,
    recall: InteractiveRecallRecord,
  ): void {
    const row = this.agentSession(input.agent, input.agentSessionId);
    this.insertActivity(row.id, row.current_session_id, {
      schemaVersion: 1, eventId: `recall:${randomUUID()}`,
      agent: input.agent, agentSessionId: input.agentSessionId, repositoryPath: input.repositoryPath,
      source: interactiveActivitySource(input.agent), type: "session_event",
      payload: { kind: "recall", recall },
    });
  }

  private agentSession(agent: string, externalId: string): AgentSessionRow {
    const row = this.core.context.database.raw.prepare(`
      SELECT id, current_session_id, last_session_id, current_task_event_id, status
      FROM agent_sessions WHERE repository_id=? AND agent=? AND external_session_id=?
    `).get(this.core.context.marker.projectId, agent, externalId) as AgentSessionRow | undefined;
    if (!row) throw new RepoMindError("SESSION_NOT_FOUND", `Agent session ${externalId} is not registered`);
    return row;
  }

  private insertActivity(
    agentSession: string,
    sessionId: string | null,
    input: RecordActivityRequest,
  ): ActivityRecordResult {
    const redacted = redactDeep(input.payload);
    const payload = stableJson(redacted.value);
    const contentHash = hash(stableJson({
      repositoryId: this.core.context.marker.projectId,
      agentSession,
      sessionId,
      type: input.type,
      source: input.source,
      sequence: input.sequence ?? null,
      payload: redacted.value,
    }));
    const existing = this.core.context.database.raw.prepare(
      "SELECT content_hash FROM activity_events WHERE id=?",
    ).get(input.eventId) as { content_hash: string } | undefined;
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new RepoMindError("INVALID_INPUT", `Activity event ${input.eventId} was reused with different content`);
      }
      return { eventId: input.eventId, sessionId, stored: false, redactions: redacted.redactions };
    }
    const values: SqlValue[] = [
      input.eventId,
      this.core.context.marker.projectId,
      agentSession,
      sessionId,
      input.type,
      input.source,
      input.sequence ?? null,
      payload,
      contentHash,
      input.timestamp ?? Date.now(),
      Date.now(),
    ];
    (this.core.context.database.raw.prepare(`
      INSERT INTO activity_events(id, repository_id, agent_session_id, session_id, event_type, source,
        sequence, payload_json, content_hash, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `) as StatementSync).run(...values);
    return { eventId: input.eventId, sessionId, stored: true, redactions: redacted.redactions };
  }

  private activitiesForSession(sessionId: string): ActivityRow[] {
    return this.core.context.database.raw.prepare(`
      SELECT id, session_id, event_type, payload_json, occurred_at
      FROM activity_events WHERE repository_id=? AND session_id=? ORDER BY occurred_at, received_at, id
    `).all(this.core.context.marker.projectId, sessionId) as unknown as ActivityRow[];
  }

  private touch(id: string, at: number): void {
    this.core.context.database.raw.prepare(
      "UPDATE agent_sessions SET status='active', last_seen_at=?, ended_at=NULL WHERE id=?",
    ).run(at, id);
  }

  private endAgentSession(id: string, at: number): void {
    this.core.context.database.raw.prepare(`
      UPDATE agent_sessions SET status='ended', last_session_id=current_session_id,
        current_session_id=NULL, current_task_event_id=NULL,
        last_seen_at=?, ended_at=? WHERE id=?
    `).run(at, at, id);
  }
}
