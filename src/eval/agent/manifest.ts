import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { RepoMindError } from "../../errors.js";

const memoryTypeSchema = z.enum([
  "architecture", "convention", "decision", "command", "failure",
  "solution", "dependency", "location", "requirement", "risk",
]);

const checkSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
}).strict();

const memorySchema = z.object({
  type: memoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
}).strict();

const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
  baseRepository: z.string().min(1),
  baseCommit: z.string().min(1).default("HEAD"),
  prompt: z.string().min(1),
  publicChecks: z.array(checkSchema).min(1),
  hiddenChecks: z.array(checkSchema).min(1),
  memories: z.array(memorySchema).min(1),
  allowedChanges: z.array(z.string().min(1)).optional(),
}).strict();

const acceptanceSchema = z.object({
  minRepoMindHiddenPassRate: z.number().min(0).max(1).optional(),
  minHiddenPassRateDelta: z.number().min(-1).max(1).optional(),
  minRetrievalRate: z.number().min(0).max(1).optional(),
  minSessionCommitRate: z.number().min(0).max(1).optional(),
  maxMeanDurationRegressionPercent: z.number().min(0).optional(),
  requireEfficiencyImprovement: z.boolean().optional(),
  requiredTaskWins: z.array(z.string().min(1)).optional(),
}).strict();

export const agentManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
  acceptance: acceptanceSchema.optional(),
}).strict();

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type AgentTask = AgentManifest["tasks"][number];
export type AgentCheck = AgentTask["publicChecks"][number];
export type AgentAcceptanceCriteria = NonNullable<AgentManifest["acceptance"]>;

export function parseAgentManifest(value: unknown, source = "manifest"): AgentManifest {
  const parsed = agentManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", `Invalid agent manifest ${source}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const ids = parsed.data.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    throw new RepoMindError("INVALID_INPUT", `Agent manifest ${source} contains duplicate task ids`);
  }
  const unknownWins = parsed.data.acceptance?.requiredTaskWins?.filter((id) => !ids.includes(id)) ?? [];
  if (unknownWins.length) {
    throw new RepoMindError("INVALID_INPUT", `Agent manifest ${source} acceptance references unknown task ids: ${unknownWins.join(", ")}`);
  }
  return parsed.data;
}

export function loadAgentManifest(path: string): AgentManifest {
  const absolute = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read agent manifest ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const manifest = parseAgentManifest(value, path);
  return {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({
      ...task,
      baseRepository: resolve(dirname(absolute), task.baseRepository),
    })),
  };
}

export function hashAgentManifest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to hash agent manifest ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
