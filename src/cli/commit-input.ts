import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { CommitSessionInput } from "../domain/types.js";
import { RepoMindError } from "../errors.js";

const resultItemSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  summary: z.string(),
}).strict();

const commitInputSchema = z.object({
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(["success", "partial", "failed"]),
  summary: z.string(),
  decisions: z.array(z.string().min(1)).optional(),
  tests: z.array(resultItemSchema).optional(),
  commands: z.array(resultItemSchema).optional(),
  remainingWork: z.array(z.string().min(1)).optional(),
}).strict();

export function parseCommitInput(value: unknown): CommitSessionInput {
  const parsed = commitInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", "Invalid commit input", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const data = parsed.data;
  return {
    sessionId: data.sessionId,
    idempotencyKey: data.idempotencyKey,
    status: data.status,
    summary: data.summary,
    ...(data.decisions ? { decisions: data.decisions } : {}),
    ...(data.tests ? { tests: data.tests } : {}),
    ...(data.commands ? { commands: data.commands } : {}),
    ...(data.remainingWork ? { remainingWork: data.remainingWork } : {}),
  };
}

export function readCommitInput(path: string): CommitSessionInput {
  let raw: string;
  try {
    raw = readFileSync(path === "-" ? 0 : resolve(path), "utf8");
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read commit input from ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return parseCommitInput(JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown);
  } catch (error) {
    if (error instanceof RepoMindError) throw error;
    throw new RepoMindError("INVALID_INPUT", `Commit input is not valid JSON: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
