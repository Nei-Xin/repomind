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

export const agentManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
}).strict();

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type AgentTask = AgentManifest["tasks"][number];
export type AgentCheck = AgentTask["publicChecks"][number];

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
