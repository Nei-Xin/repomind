import { createHash } from "node:crypto";
import { z } from "zod";
import type { CommandEvidenceSource, StructuredHandoffV1 } from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import { redactDeep, redactSecrets } from "../security/redaction.js";
import { solutionSummaryTitle } from "./solution-summary.js";

function withinCodePoints(value: string, maximum: number): boolean {
  let length = 0;
  for (const _character of value) if (++length > maximum) return false;
  return true;
}

const paragraphSchema = z.string().min(1).regex(/\S/u)
  .refine((value) => withinCodePoints(value, 2_000), "Paragraph exceeds 2000 Unicode code points")
  .describe("An exact complete source paragraph, at most 2000 Unicode code points.");
const paragraphsSchema = z.array(paragraphSchema).max(16)
  .refine((items) => new Set(items).size === items.length, "Paragraphs must be unique");

const paragraphNumbersSchema = z.array(z.number().int().positive().safe()).max(16)
  .refine((items) => new Set(items).size === items.length, "Paragraph references must be unique");

/** Host-only v2 selects whole prose paragraphs instead of copying their text. */
export const hostParagraphHandoffSchema = z.object({
  version: z.literal(2),
  constraints: paragraphNumbersSchema,
  remainingWork: paragraphNumbersSchema,
}).strict();
export type HostParagraphHandoffV2 = z.infer<typeof hostParagraphHandoffSchema>;

/** Shared by explicit CLI/MCP inputs and the Core boundary; no transforms. */
export const structuredHandoffSchema = z.object({
  version: z.literal(1),
  constraints: paragraphsSchema,
  remainingWork: paragraphsSchema,
}).strict();

export interface HandoffSourceParagraph {
  text: string;
  /** UTF-16 offsets in the summary identified by summarySha256. */
  start: number;
  end: number;
}

interface ValidatedHandoff {
  rawHandoff: StructuredHandoffV1;
  constraints: HandoffSourceParagraph[];
  remainingWork: HandoffSourceParagraph[];
  title: string;
  titleSource: "structured-constraint" | "legacy-summary";
}

export interface HandoffVerificationItem {
  evidenceId: string;
  command: string;
  exitCode: number;
  source: CommandEvidenceSource;
}

export interface HandoffAudit extends Omit<ValidatedHandoff, "title" | "rawHandoff"> {
  rawHandoff: StructuredHandoffV1 | HostParagraphHandoffV2 | null;
  protocolVersion: 1 | 2;
  disposition: "accepted" | "absent" | "rejected";
  producer: "explicit-input" | "opencode-host";
  reasonCodes: string[];
  /** Structural/source validation only; natural-language semantic completeness is not inferred. */
  semanticValidation: "not-performed";
  /** Hash and offsets refer to persisted, redacted Evidence, not secret input. */
  summarySha256: string;
  verification: HandoffVerificationItem[];
  solution: {
    memoryId: string | null;
    disposition: "stored" | "deduplicated" | "skipped-retired" | "not-eligible" | "blocked-handoff";
    titleApplied: boolean;
  };
}

export interface ExplicitHandoffAudit extends HandoffAudit {
  protocolVersion: 1;
  rawHandoff: StructuredHandoffV1;
  disposition: "accepted";
  producer: "explicit-input";
}

function invalid(reason: string): never {
  throw new RepoMindError("INVALID_INPUT", "Invalid structured handoff", { reason });
}

function sourceParagraphs(summary: string): HandoffSourceParagraph[] {
  const paragraphs: HandoffSourceParagraph[] = [];
  let start: number | undefined;
  let end = 0;
  const flush = (): void => {
    if (start !== undefined) paragraphs.push({ text: summary.slice(start, end), start, end });
    start = undefined;
  };
  for (const match of summary.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0].replace(/\r?\n$/u, "");
    if (/^[ \t]*$/u.test(line)) flush();
    else {
      start ??= match.index;
      end = match.index + line.length;
    }
  }
  flush();
  return paragraphs;
}

/** Expand references only to complete paragraphs; never match or repair substrings. */
export function resolveHostParagraphHandoff(summary: string, value: unknown): {
  rawHandoff: HostParagraphHandoffV2; expanded: StructuredHandoffV1;
} {
  const parsed = hostParagraphHandoffSchema.safeParse(value);
  if (!parsed.success) invalid("schema-invalid");
  const paragraphs = sourceParagraphs(summary);
  const resolve = (numbers: number[]): string[] => numbers.map((number) => {
    const paragraph = paragraphs[number - 1];
    if (!paragraph) invalid("paragraph-reference-out-of-range");
    return paragraph.text;
  });
  return { rawHandoff: parsed.data, expanded: {
    version: 1, constraints: resolve(parsed.data.constraints), remainingWork: resolve(parsed.data.remainingWork),
  } };
}

/** Validate against the submitted prose before Git collection or any writes. */
export function validateStructuredHandoff(
  summary: string, value: unknown, legacyRemainingWork?: readonly string[], allowCrossCategoryReuse = false,
): ValidatedHandoff {
  const parsed = structuredHandoffSchema.safeParse(value);
  if (!parsed.success) invalid("schema-invalid");
  const handoff = parsed.data;
  if (summary.includes("\u0000")) invalid("nul-in-summary");
  if ([...handoff.constraints, ...handoff.remainingWork].reduce((n, text) => n + [...text].length, 0) > 4_000) {
    invalid("total-length-exceeded");
  }
  if (legacyRemainingWork !== undefined && (legacyRemainingWork.length !== handoff.remainingWork.length
    || legacyRemainingWork.some((text, index) => text !== handoff.remainingWork[index]))) invalid("remaining-work-conflict");
  const paragraphs = sourceParagraphs(summary);
  const used = new Set<number>();
  const resolve = (items: string[], category: "constraints" | "remainingWork"): HandoffSourceParagraph[] => {
    let previous = -1;
    return items.map((text) => {
      const matches = paragraphs.filter((paragraph) => paragraph.text === text);
      if (!matches.length) invalid("not-whole-source-paragraph");
      if (matches.length > 1) invalid("ambiguous-source-paragraph");
      const paragraph = matches[0]!;
      if (used.has(paragraph.start) && !allowCrossCategoryReuse) invalid("paragraph-reused");
      if (paragraph.start <= previous) invalid("source-order-mismatch");
      previous = paragraph.start;
      if (!allowCrossCategoryReuse || category === "constraints") used.add(paragraph.start);
      return paragraph;
    });
  };
  const constraints = resolve(handoff.constraints, "constraints");
  const remainingWork = resolve(handoff.remainingWork, "remainingWork");
  const first = constraints[0]?.text;
  const useConstraint = first !== undefined && !/[\r\n\u2028\u2029]/u.test(first)
    && /[.?!。！？]$/u.test(first) && first.length <= 160;
  return {
    rawHandoff: handoff, constraints, remainingWork,
    title: useConstraint ? first : solutionSummaryTitle(summary),
    titleSource: useConstraint ? "structured-constraint" : "legacy-summary",
  };
}

/** Re-resolve after redaction so persisted spans never point into pre-redaction text. */
export function prepareExplicitHandoff(
  summary: string, value: unknown, legacyRemainingWork?: readonly string[], allowCrossCategoryReuse = false,
): { title: string; audit: ExplicitHandoffAudit } {
  const validated = validateStructuredHandoff(summary, value, legacyRemainingWork, allowCrossCategoryReuse);
  const persistedSummary = redactSecrets(summary).content;
  let persisted: ValidatedHandoff;
  try {
    persisted = validateStructuredHandoff(persistedSummary, redactDeep(validated.rawHandoff).value, undefined, allowCrossCategoryReuse);
  } catch {
    // Redaction can collapse distinct paragraphs or remove paragraph boundaries.
    // Never persist misleading offsets or fall back to storing the secret text.
    invalid("redacted-source-mismatch");
  }
  const { title, ...annotations } = persisted;
  return { title, audit: {
    ...annotations, protocolVersion: 1, disposition: "accepted", producer: "explicit-input", reasonCodes: [],
    summarySha256: createHash("sha256").update(persistedSummary, "utf8").digest("hex"), semanticValidation: "not-performed",
    verification: [], solution: { memoryId: null, disposition: "not-eligible", titleApplied: false },
  } };
}
