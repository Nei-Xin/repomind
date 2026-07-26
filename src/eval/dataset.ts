import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { RepoMindError } from "../errors.js";

const memoryTypeSchema = z.enum([
  "architecture", "convention", "decision", "command", "failure",
  "solution", "dependency", "location", "requirement", "risk",
]);

const seedMemorySchema = z.object({
  type: memoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  scopeType: z.enum(["repository", "module", "path"]).optional(),
  scopeValue: z.string().optional(),
  tags: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
}).strict();

const evalQuerySchema = z.object({
  query: z.string().min(1),
  expect: z.array(z.string().min(1)).min(1),
  types: z.array(memoryTypeSchema).optional(),
}).strict();

export const evalDatasetSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  memories: z.array(seedMemorySchema).min(1),
  queries: z.array(evalQuerySchema).min(1),
}).strict();

export type EvalDataset = z.infer<typeof evalDatasetSchema>;

export function loadDataset(path: string): EvalDataset {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read dataset ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Dataset is not valid JSON: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const parsed = evalDatasetSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", `Invalid dataset ${path}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const titles = new Set(parsed.data.memories.map((memory) => memory.title));
  if (titles.size !== parsed.data.memories.length) {
    const seen = new Set<string>();
    const duplicates = [...new Set(parsed.data.memories.map((memory) => memory.title).filter((title) => !seen.add(title)))];
    throw new RepoMindError("INVALID_INPUT", `Dataset ${path} has duplicate memory titles, which makes recall ambiguous: ${duplicates.join(", ")}`);
  }
  for (const query of parsed.data.queries) {
    for (const expected of query.expect) {
      if (!titles.has(expected)) {
        throw new RepoMindError("INVALID_INPUT", `Query "${query.query}" expects unknown memory title "${expected}"`);
      }
    }
  }
  return parsed.data;
}
