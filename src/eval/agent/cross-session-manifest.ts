import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { RepoMindError } from "../../errors.js";

const checkSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
}).strict();

export const CROSS_SESSION_RUNNERS = ["opencode", "claude"] as const;
export const DEFAULT_MIN_COMPARABLE_PAIR_COVERAGE_RATE = 0.8;
const runnerSchema = z.enum(CROSS_SESSION_RUNNERS);

const stageSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
  runner: runnerSchema.optional(),
  model: z.string().min(1).optional(),
  maxMemories: z.number().int().min(0).max(20).optional(),
  prompt: z.string().min(1),
  publicChecks: z.array(checkSchema).min(1),
  hiddenChecks: z.array(checkSchema).min(1),
  allowedChanges: z.array(z.string().min(1)).optional(),
}).strict();

const sequenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
  baseRepository: z.string().min(1),
  baseCommit: z.string().min(1).default("HEAD"),
  stages: z.array(stageSchema).min(2).max(20),
}).strict();

const acceptanceSchema = z.object({
  minSharedTransferHiddenPassRate: z.number().min(0).max(1).optional(),
  minTransferHiddenPassRateDelta: z.number().min(-1).max(1).optional(),
  minSharedRecallRate: z.number().min(0).max(1).optional(),
  maxIsolatedRecallRate: z.number().min(0).max(1).optional(),
  minSharedCommitRate: z.number().min(0).max(1).optional(),
  minSharedDerivedRecallRate: z.number().min(0).max(1).optional(),
  minSharedL2RecallRate: z.number().min(0).max(1).optional(),
  minSharedL3RecallRate: z.number().min(0).max(1).optional(),
  maxSharedDerivedStageL1RecallRate: z.number().min(0).max(1).optional(),
  maxIsolatedDerivedRecallRate: z.number().min(0).max(1).optional(),
  maxMeanDurationRegressionPercent: z.number().min(0).optional(),
  maxMeanInputTokenRegressionPercent: z.number().min(0).optional(),
  minInputTokenPairedWinRate: z.number().min(0).max(1).optional(),
  maxMeanTotalPromptTokenRegressionPercent: z.number().min(0).optional(),
  minTotalPromptTokenPairedWinRate: z.number().min(0).max(1).optional(),
  minAgentDurationPairedWinRate: z.number().min(0).max(1).optional(),
  minComparablePairCoverageRate: z.number().min(0).max(1).optional(),
}).strict();

export const crossSessionManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  sequences: z.array(sequenceSchema).min(1),
  acceptance: acceptanceSchema.optional(),
}).strict();

export type CrossSessionManifest = z.infer<typeof crossSessionManifestSchema>;
export type CrossSessionRunner = typeof CROSS_SESSION_RUNNERS[number];
export type CrossSessionSequence = CrossSessionManifest["sequences"][number];
export type CrossSessionStage = CrossSessionSequence["stages"][number];
export type CrossSessionCheck = CrossSessionStage["publicChecks"][number];
export type CrossSessionAcceptanceCriteria = NonNullable<CrossSessionManifest["acceptance"]>;

export function parseCrossSessionManifest(value: unknown, source = "manifest"): CrossSessionManifest {
  const parsed = crossSessionManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", `Invalid cross-session manifest ${source}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const sequenceIds = parsed.data.sequences.map((sequence) => sequence.id);
  if (new Set(sequenceIds).size !== sequenceIds.length) {
    throw new RepoMindError("INVALID_INPUT", `Cross-session manifest ${source} contains duplicate sequence ids`);
  }
  for (const sequence of parsed.data.sequences) {
    const stageIds = sequence.stages.map((stage) => stage.id);
    if (new Set(stageIds).size !== stageIds.length) {
      throw new RepoMindError(
        "INVALID_INPUT",
        `Cross-session manifest ${source} sequence ${sequence.id} contains duplicate stage ids`,
      );
    }
  }
  return parsed.data;
}

export function loadCrossSessionManifest(path: string): CrossSessionManifest {
  const absolute = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to read cross-session manifest ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const manifest = parseCrossSessionManifest(value, path);
  return {
    ...manifest,
    sequences: manifest.sequences.map((sequence) => ({
      ...sequence,
      baseRepository: resolve(dirname(absolute), sequence.baseRepository),
    })),
  };
}

export function hashCrossSessionManifest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
  } catch (error) {
    throw new RepoMindError("INVALID_INPUT", `Unable to hash cross-session manifest ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
