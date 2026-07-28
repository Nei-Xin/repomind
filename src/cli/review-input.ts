import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { MemoryReviewAction } from "../domain/types.js";
import { RepoMindError } from "../errors.js";

const reviewActionSchema = z.object({
  memoryId: z.string().min(1),
  action: z.enum(["validate", "invalidate"]),
  reason: z.string().min(1),
}).strict();

const reviewInputSchema = z.object({
  actions: z.array(reviewActionSchema).min(1).max(100),
}).strict();

export function parseReviewInput(value: unknown): MemoryReviewAction[] {
  const parsed = reviewInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", "Invalid review input", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data.actions;
}

export function readReviewInput(path: string): MemoryReviewAction[] {
  try {
    const raw = readFileSync(path === "-" ? 0 : resolve(path), "utf8");
    return parseReviewInput(JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown);
  } catch (error) {
    if (error instanceof RepoMindError) throw error;
    throw new RepoMindError("INVALID_INPUT", `Unable to read review input from ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
