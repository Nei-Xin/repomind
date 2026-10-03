import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareExplicitHandoff, structuredHandoffSchema, validateStructuredHandoff } from "../src/extraction/structured-handoff.js";
import { redactSecrets } from "../src/security/redaction.js";

const examples = JSON.parse(readFileSync(new URL("../docs-zh-CN/structured-handoff-v1/examples.json", import.meta.url), "utf8")).cases as Array<{
  id: string; summary: string; handoff: unknown; remainingWork?: string[];
  expected: { schemaValid: boolean; accepted: boolean; reason?: string; title?: string; titleSource?: string };
}>;
const handoff = (constraints: string[], remainingWork: string[] = []) => ({ version: 1 as const, constraints, remainingWork });

describe("structured handoff validation", () => {
  it.each(examples)("checks the documented $id contract", (fixture) => {
    expect(structuredHandoffSchema.safeParse(fixture.handoff).success).toBe(fixture.expected.schemaValid);
    if (!fixture.expected.accepted) {
      expect(() => validateStructuredHandoff(fixture.summary, fixture.handoff, fixture.remainingWork))
        .toThrow(expect.objectContaining({ code: "INVALID_INPUT", details: { reason: fixture.expected.reason } }));
      return;
    }
    const result = prepareExplicitHandoff(fixture.summary, fixture.handoff, fixture.remainingWork);
    expect(result.audit.titleSource).toBe(fixture.expected.titleSource);
    if (fixture.expected.title) expect(result.title).toBe(fixture.expected.title);
    for (const paragraph of [...result.audit.constraints, ...result.audit.remainingWork]) {
      expect(fixture.summary.slice(paragraph.start, paragraph.end)).toBe(paragraph.text);
    }
    expect(result.audit.verification).toEqual([]);
  });

  it("preserves CRLF, indentation, trailing spaces, leading/trailing blank lines and UTF-16 offsets", () => {
    const constraint = "  🧪 保留 e\u0301。  \r\n  仅适用于 Linux。";
    const summary = ` \t\r\nHeader 🧪.\r\n\t \r\n${constraint}\r\n\r\nRemaining.\r\n \t`;
    const result = validateStructuredHandoff(summary, handoff([constraint], ["Remaining."]));
    expect(result.constraints).toEqual([{ text: constraint, start: summary.indexOf(constraint), end: summary.indexOf(constraint) + constraint.length }]);
    expect(result.remainingWork[0]!.text).toBe("Remaining.");
    expect(result.titleSource).toBe("legacy-summary");
    expect(() => validateStructuredHandoff(summary, handoff([constraint.normalize("NFC")]))).toThrow();
    expect(() => validateStructuredHandoff(summary, handoff([constraint.trim()]))).toThrow();
  });

  it("enforces code-point item/total limits and item counts without rejecting surrogate pairs", () => {
    const a = "🧪".repeat(1_999) + ".";
    const b = "界".repeat(1_999) + ".";
    expect(() => validateStructuredHandoff(`${a}\n\n${b}`, handoff([a], [b]))).not.toThrow();
    expect(() => validateStructuredHandoff(a + "x", handoff([a + "x"]))).toThrow();
    expect(() => validateStructuredHandoff(`${a}\n\n${b}\n\nx`, handoff([a, b], ["x"])))
      .toThrow(expect.objectContaining({ details: { reason: "total-length-exceeded" } }));
    const entries = Array.from({ length: 17 }, (_, index) => `Constraint ${index}.`);
    expect(() => validateStructuredHandoff(entries.join("\n\n"), handoff(entries.slice(0, 16)))).not.toThrow();
    expect(() => validateStructuredHandoff(entries.join("\n\n"), handoff(entries))).toThrow();
  });

  it.each([
    "🧪".repeat(80) + ".", // 81 code points but 161 UTF-16 units.
    "First line.\nSecond line.",
    "First line.\u2028Second line.",
    "Incomplete heading:",
  ])("does not truncate or skip an unsuitable first constraint: %s", (first) => {
    const summary = `Review closed.\n\n${first}\n\nShort constraint.`;
    expect(validateStructuredHandoff(summary, handoff([first, "Short constraint."])))
      .toMatchObject({ title: "Review closed.", titleSource: "legacy-summary" });
  });

  it("uses a whole multi-sentence paragraph at the exact title limit", () => {
    const constraint = "Only on Linux. " + "x".repeat(144) + ".";
    expect(constraint.length).toBe(160);
    expect(validateStructuredHandoff(constraint, handoff([constraint]))).toMatchObject({ title: constraint, titleSource: "structured-constraint" });
  });

  it.each([null, { version: 1, constraints: [], remainingWork: [], evidenceIds: ["evd_fake"] }, { version: 1, constraints: ["x", "x"], remainingWork: [] }])(
    "rejects invalid shapes without echoing the submitted values", (value) => {
      expect(() => validateStructuredHandoff("x", value)).toThrow(expect.objectContaining({
        code: "INVALID_INPUT", details: { reason: "schema-invalid" },
      }));
    },
  );

  it("rejects NUL even when the annotation itself is empty", () => {
    expect(() => validateStructuredHandoff("Notes.\u0000", handoff([])))
      .toThrow(expect.objectContaining({ details: { reason: "nul-in-summary" } }));
  });

  it("rebases audit spans and hashes onto the persisted redacted summary", () => {
    const secret = "sk-" + "a".repeat(24);
    const summary = `Credential ${secret}.\n\nPreserve exact bytes.`;
    const result = prepareExplicitHandoff(summary, handoff(["Preserve exact bytes."]));
    const persisted = redactSecrets(summary).content;
    expect(result.audit.summarySha256).toBe(createHash("sha256").update(persisted).digest("hex"));
    expect(result.audit.constraints[0]!.start).toBe(persisted.indexOf("Preserve exact bytes."));
    expect(result.audit.constraints[0]!.start).not.toBe(summary.indexOf("Preserve exact bytes."));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects ambiguous redacted source instead of persisting misleading offsets", () => {
    const a = "sk-" + "a".repeat(24), b = "sk-" + "b".repeat(24);
    expect(() => prepareExplicitHandoff(`${a}\n\n${b}`, handoff([a])))
      .toThrow(expect.objectContaining({ details: { reason: "redacted-source-mismatch" } }));
  });
});
