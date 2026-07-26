import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { RepoMindError } from "../../errors.js";

const resultSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  summary: z.string(),
}).strict();

const sessionSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  status: z.enum(["success", "partial", "failed"]),
  summary: z.string(),
  decisions: z.array(z.string().min(1)).optional(),
  tests: z.array(resultSchema).optional(),
  commands: z.array(resultSchema).optional(),
  /** Human knowledge the deterministic extractor cannot derive; goes to the raw
   * corpus and, when `record` is true, to a manual memory. */
  notes: z.array(z.string().min(1)).optional(),
  edits: z.record(z.string()).optional(),
  recordNotes: z.boolean().optional(),
}).strict();

const goldFactSchema = z.object({
  key: z.string().min(1),
  matcher: z.object({
    allOf: z.array(z.string().min(1)).optional(),
    anyOf: z.array(z.array(z.string().min(1))).optional(),
  }).strict(),
  status: z.enum(["current", "stale", "conflicted"]),
  staleDetectability: z.enum(["file-hash", "prose-only"]).optional(),
  supportedBy: z.array(z.string().min(1)).min(1),
  requiredFor: z.enum(["success", "bonus"]),
  discoverableFrom: z.array(z.string().min(1)).optional(),
  repoDiscoverable: z.boolean(),
  decisionOnly: z.boolean().optional(),
}).strict();

export const fixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  name: z.string().min(1),
  category: z.string().min(1),
  adversarial: z.boolean(),
  repo: z.object({
    files: z.record(z.string()),
    commits: z.array(z.object({ message: z.string().min(1), files: z.array(z.string().min(1)) }).strict()).min(1),
  }).strict(),
  history: z.array(sessionSchema).min(1),
  governanceOps: z.array(z.object({
    op: z.enum(["correct", "invalidate", "validate"]),
    targetTitle: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    reason: z.string().min(1),
  }).strict()).optional(),
  mutations: z.array(z.object({
    kind: z.enum(["write", "delete"]),
    path: z.string().min(1),
    content: z.string().optional(),
  }).strict()).optional(),
  query: z.string().min(1),
  goldFacts: z.array(goldFactSchema),
  designedLoss: z.array(z.object({
    arm: z.string().min(1),
    metric: z.string().min(1),
    mode: z.enum(["win", "tie-or-win"]).optional(),
    rationale: z.string().min(1),
  }).strict()).optional(),
  designedCost: z.array(z.object({
    metric: z.string().min(1),
    min: z.number(),
    rationale: z.string().min(1),
  }).strict()).optional(),
  waivers: z.array(z.object({
    gate: z.string().min(1),
    reason: z.string().min(1),
    sinceFixtureVersion: z.number().int(),
  }).strict()).optional(),
  /** Placements to run separately; only used by the long-history fixture. */
  placements: z.array(z.enum(["relevant-early", "relevant-late"])).optional(),
}).strict();

export type Fixture = z.infer<typeof fixtureSchema>;
export type FixtureSession = z.infer<typeof sessionSchema>;
export type GoldFact = z.infer<typeof goldFactSchema>;

export function parseFixture(value: unknown, source: string): Fixture {
  const parsed = fixtureSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", `Invalid fixture ${source}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

export function loadFixture(path: string): { fixture: Fixture; sha256: string } {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read fixture ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const text = raw.replace(/^﻿/u, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Fixture is not valid JSON: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return { fixture: parseFixture(value, path), sha256: createHash("sha256").update(text).digest("hex") };
}
