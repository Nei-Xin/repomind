import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { RepoMindError } from "../errors.js";

const memoryTypeSchema = z.enum([
  "architecture", "convention", "decision", "command", "failure", "solution",
  "dependency", "location", "requirement", "risk",
]);

export const extractionCandidateSchema = z.object({
  type: memoryTypeSchema,
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8_000),
  confidence: z.number().min(0).max(0.9),
  scopeType: z.enum(["repository", "module", "path"]),
  scopeValue: z.string().trim().min(1).max(500).nullable(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20),
  relatedFiles: z.array(z.string().trim().min(1).max(500)).max(50),
  evidenceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
}).strict();

export const extractionOutputSchema = z.object({
  candidates: z.array(extractionCandidateSchema).max(50),
}).strict();

export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "content", "confidence", "scopeType", "scopeValue", "tags", "relatedFiles", "evidenceIds"],
        properties: {
          type: { enum: memoryTypeSchema.options },
          title: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: "string", minLength: 1, maxLength: 8_000 },
          confidence: { type: "number", minimum: 0, maximum: 0.9 },
          scopeType: { enum: ["repository", "module", "path"] },
          scopeValue: { type: ["string", "null"] },
          tags: { type: "array", maxItems: 20, items: { type: "string" } },
          relatedFiles: { type: "array", maxItems: 50, items: { type: "string" } },
          evidenceIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
        },
      },
    },
  },
};

function repositoryRelativePath(root: string, value: string): string {
  if (isAbsolute(value)) throw new RepoMindError("INVALID_INPUT", `Remote extraction returned an absolute related file path: ${value}`);
  const absolute = resolve(root, value);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RepoMindError("INVALID_INPUT", `Remote extraction returned a related file outside the repository: ${value}`);
  }
  return fromRoot.replaceAll("\\", "/");
}

export function validateExtractionOutput(output: unknown, allowedEvidenceIds: ReadonlySet<string>, repositoryRoot: string): ExtractionOutput {
  const parsed = extractionOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", "Remote extraction returned invalid structured output", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  return {
    candidates: parsed.data.candidates.map((candidate, index) => {
      const evidenceIds = [...new Set(candidate.evidenceIds)];
      if (evidenceIds.length !== candidate.evidenceIds.length) {
        throw new RepoMindError("INVALID_INPUT", `Remote extraction candidate ${index} contains duplicate Evidence IDs`);
      }
      for (const evidenceId of evidenceIds) {
        if (!allowedEvidenceIds.has(evidenceId)) {
          throw new RepoMindError("INVALID_INPUT", `Remote extraction candidate ${index} references unavailable Evidence ${evidenceId}`);
        }
      }
      if (candidate.scopeType === "repository" && candidate.scopeValue !== null) {
        throw new RepoMindError("INVALID_INPUT", `Remote extraction candidate ${index} gives repository scope a value`);
      }
      if (candidate.scopeType !== "repository" && candidate.scopeValue === null) {
        throw new RepoMindError("INVALID_INPUT", `Remote extraction candidate ${index} omits its ${candidate.scopeType} scope value`);
      }
      const scopeValue = candidate.scopeValue === null ? null : repositoryRelativePath(repositoryRoot, candidate.scopeValue);
      return {
        ...candidate,
        scopeValue,
        tags: [...new Set(candidate.tags)],
        relatedFiles: [...new Set(candidate.relatedFiles.map((file) => repositoryRelativePath(repositoryRoot, file)))],
        evidenceIds,
      };
    }),
  };
}
