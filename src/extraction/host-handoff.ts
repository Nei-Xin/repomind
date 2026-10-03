import { createHash } from "node:crypto";
import { RepoMindError } from "../errors.js";
import { redactSecrets } from "../security/redaction.js";
import { solutionSummaryTitle } from "./solution-summary.js";
import { prepareExplicitHandoff, type HandoffAudit } from "./structured-handoff.js";

export const STRUCTURED_HANDOFF_INSTRUCTION = [
  "## Final handoff output protocol (RepoMind v1)",
  "Finish with a natural-language summary preserving constraints, verification outcomes, warnings and remaining work.",
  "Use complete, independently understandable paragraphs; keep conditions with the claims they qualify. Do not claim pending work is implemented.",
  "Preserve every independently testable input-to-result relationship explicitly, including conditions, exceptions, negative cases and remaining work. Write durable behavior constraints in separate paragraphs from completed operations and test results.",
  "After the prose, append exactly one top-level terminal ```repomind-handoff fenced block containing a JSON object with only version: 1, constraints: string[], remainingWork: string[].",
  "Each array entry must copy one unique complete paragraph from the prose exactly, in source order. Do not copy only part of a paragraph. Never repeat a paragraph across the arrays.",
  "Use at most 16 entries per array, 2000 Unicode code points per entry and 4000 total. Use empty arrays when there is nothing to annotate. No verification, evidence IDs or status fields are allowed.",
  "Keep the JSON block under 8000 UTF-16 code units and the entire final answer under 12000. Put no text after the closing fence. Do not write a protocol file or call RepoMind tools.",
].join("\n");

export interface HostHandoffCapture {
  requested: true;
  /** Collector-owned loss/terminal checks, before summary sanitizing or clipping. */
  rejectionReasons: string[];
  block?: { start: number; end: number };
}

export interface HostHandoffReport {
  requested: true;
  persisted: boolean;
  summaryEvidenceId: string | null;
  audit: HandoffAudit;
}

function reject(reason: string): never {
  throw new RepoMindError("INVALID_INPUT", "Invalid Host handoff", { reason });
}

/** JSON.parse validates grammar; this token walk rejects duplicate decoded keys at every depth. */
function parseUniqueJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { reject("invalid-json"); }
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu) ?? [];
  const stack: Array<{ kind: string; keys: Set<string>; keyExpected: boolean }> = [];
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token === "{" || token === "[") {
      stack.push({ kind: token, keys: new Set(), keyExpected: token === "{" });
    } else if (token === "}" || token === "]") stack.pop();
    else if (parent?.kind === "{") {
      if (token === ",") parent.keyExpected = true;
      else if (parent.keyExpected && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key)) reject("duplicate-json-key");
        parent.keys.add(key);
        parent.keyExpected = false;
      }
    }
  }
  return parsed;
}

/** Fence state prevents protocol-looking examples inside larger fences from being accepted. */
function terminalBlock(summary: string): { start: number; end: number; json: string; prose: string } | undefined {
  let fence: { character: string; length: number; protocol: boolean; start: number; body: number } | undefined;
  const blocks: Array<{ start: number; end: number; json: string }> = [];
  let invalidMarker = false;
  for (const match of summary.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0].replace(/\r?\n$/u, "");
    const marker = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[2]![0] === fence.character && marker[2]!.length >= fence.length && !marker[3]!.trim()) {
        if (fence.protocol) {
          if (line !== "```") invalidMarker = true;
          blocks.push({ start: fence.start, end: match.index + line.length, json: summary.slice(fence.body, match.index) });
        }
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      const protocol = line === "```repomind-handoff";
      if (line.includes("repomind-handoff") && !protocol) invalidMarker = true;
      fence = { character: marker[2]![0]!, length: marker[2]!.length, protocol, start: match.index, body: match.index + match[0].length };
    } else if (/^\s*(?:>\s*)?[`~]{3,}\s*repomind-handoff\b/u.test(line)) invalidMarker = true;
  }
  if (fence?.protocol) reject("unclosed-protocol-block");
  if (invalidMarker) reject("unsupported-protocol-fence");
  if (blocks.length > 1) reject("multiple-protocol-blocks");
  const block = blocks[0];
  if (!block) return undefined;
  if (summary.slice(block.end).trim()) reject("text-after-protocol");
  if (block.end - block.start > 8_000) reject("protocol-block-too-long");
  const prose = summary.slice(0, block.start).replace(/(?:\r?\n[ \t]*)+$/u, "");
  if (!prose.trim()) reject("missing-prose");
  return { ...block, prose };
}

/** Called on the untouched final answer; only bounded collector diagnostics cross the boundary. */
export function captureHostHandoff(summary: string, options: { finalAnswer: boolean; stdoutTruncated: boolean }): HostHandoffCapture {
  const rejectionReasons: string[] = [];
  if (!options.finalAnswer) rejectionReasons.push("unconfirmed-final-answer");
  if (options.stdoutTruncated) rejectionReasons.push("output-truncated");
  if (summary.length > 12_000) rejectionReasons.push("summary-too-long");
  if (summary.includes("\u0000")) rejectionReasons.push("nul-in-summary");
  const capture: HostHandoffCapture = { requested: true, rejectionReasons };
  if (!rejectionReasons.length) {
    try {
      const block = terminalBlock(summary);
      if (block) capture.block = { start: block.start, end: block.end };
    } catch (error) { rejectionReasons.push(reasonOf(error)); }
  }
  return capture;
}

function reasonOf(error: unknown): string {
  if (error instanceof RepoMindError && typeof error.details?.reason === "string") return error.details.reason;
  throw error;
}

/** Core repeats structural/source checks. Rejection keeps Evidence but blocks summary promotion. */
export function prepareHostHandoff(summary: string, capture: HostHandoffCapture): { title: string; content: string; audit: HandoffAudit } {
  const fallback = (disposition: "absent" | "rejected", reasonCodes: string[]) => {
    const content = summary;
    return { content, title: solutionSummaryTitle(content), audit: {
      protocolVersion: 1 as const, producer: "opencode-host" as const, disposition, reasonCodes,
      rawHandoff: null, constraints: [], remainingWork: [], verification: [], titleSource: "legacy-summary" as const,
      summarySha256: createHash("sha256").update(redactSecrets(summary).content, "utf8").digest("hex"), semanticValidation: "not-performed" as const,
      solution: { memoryId: null, disposition: disposition === "rejected" ? "blocked-handoff" as const : "not-eligible" as const, titleApplied: false },
    } };
  };
  if (capture.rejectionReasons.length) return fallback("rejected", [...capture.rejectionReasons]);
  try {
    if (summary.length > 12_000) reject("summary-too-long");
    if (summary.includes("\u0000")) reject("nul-in-summary");
    const block = terminalBlock(summary);
    if (!block) return fallback(capture.block ? "rejected" : "absent", [capture.block ? "protocol-range-mismatch" : "missing-protocol"]);
    if (block.start !== capture.block?.start || block.end !== capture.block?.end) reject("protocol-range-mismatch");
    const value = parseUniqueJson(block.json);
    const prepared = prepareExplicitHandoff(block.prose, value);
    const persistedSummary = redactSecrets(summary).content;
    // Whole-answer redaction may span the protocol boundary. Require a faithful prose prefix.
    if (!persistedSummary.startsWith(redactSecrets(block.prose).content)) reject("redacted-source-mismatch");
    return { title: prepared.title, content: block.prose, audit: {
      ...prepared.audit, producer: "opencode-host",
      summarySha256: createHash("sha256").update(persistedSummary, "utf8").digest("hex"),
    } };
  } catch (error) { return fallback("rejected", [reasonOf(error)]); }
}
