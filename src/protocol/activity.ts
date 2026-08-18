import { z } from "zod";

export const codingAgentSchema = z.enum(["claude"]);
export const activitySourceSchema = z.enum(["claude-hook", "memory-proxy"]);
export const activityTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "tool_failure",
  "session_event",
]);

const eventIdSchema = z.string().trim().min(1).max(256);
const externalSessionIdSchema = z.string().trim().min(1).max(256);
const repositoryPathSchema = z.string().trim().min(1).max(4096);
const timestampSchema = z.number().int().nonnegative().optional();

export const registerAgentSessionSchema = z.object({
  schemaVersion: z.literal(1),
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema,
  timestamp: timestampSchema,
}).strict();

export const startInteractiveTaskSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: eventIdSchema,
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema,
  task: z.string().trim().min(1).max(100_000),
  maxMemories: z.number().int().min(0).max(20).optional(),
  timestamp: timestampSchema,
}).strict();

export const recordActivitySchema = z.object({
  schemaVersion: z.literal(1),
  eventId: eventIdSchema,
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema.optional(),
  source: activitySourceSchema,
  type: activityTypeSchema,
  sequence: z.number().int().nonnegative().optional(),
  timestamp: timestampSchema,
  payload: z.unknown(),
}).strict();

export const finishInteractiveTaskSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: eventIdSchema,
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema,
  summary: z.string().max(100_000).default(""),
  status: z.enum(["success", "partial", "failed"]).optional(),
  timestamp: timestampSchema,
}).strict();

export const abortInteractiveTaskSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: eventIdSchema,
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema,
  reason: z.string().trim().min(1).max(10_000),
  timestamp: timestampSchema,
}).strict();

export const recallInteractiveContextSchema = z.object({
  schemaVersion: z.literal(1),
  agent: codingAgentSchema,
  agentSessionId: externalSessionIdSchema,
  repositoryPath: repositoryPathSchema,
  query: z.string().trim().min(1).max(100_000),
  maxMemories: z.number().int().min(0).max(20).optional(),
  timestamp: timestampSchema,
}).strict();

export type CodingAgent = z.infer<typeof codingAgentSchema>;
export type ActivitySource = z.infer<typeof activitySourceSchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type RegisterAgentSessionRequest = z.infer<typeof registerAgentSessionSchema>;
export type StartInteractiveTaskRequest = z.infer<typeof startInteractiveTaskSchema>;
export type RecordActivityRequest = z.infer<typeof recordActivitySchema>;
export type FinishInteractiveTaskRequest = z.infer<typeof finishInteractiveTaskSchema>;
export type AbortInteractiveTaskRequest = z.infer<typeof abortInteractiveTaskSchema>;
export type RecallInteractiveContextRequest = z.infer<typeof recallInteractiveContextSchema>;
