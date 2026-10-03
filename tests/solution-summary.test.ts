import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactSolutionSummary, memoryTextWithoutDuplicateTitle, solutionSummaryTitle } from "../src/extraction/solution-summary.js";

// Historical expectedContent/expectedTitle fields describe the removed phrase-based
// formatting. Keep original outputs and hashes unchanged; preserve full source now.
const historical = ["solution-handoffs.json", "solution-handoffs-heldout.json"].flatMap((name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))) as Array<{
    id: string; source: { sha256: string }; summary: string;
  }>;
describe("historical model output preservation", () => {
  it.each(historical)("preserves every byte and its order for $id", (fixture) => {
    expect(createHash("sha256").update(fixture.summary).digest("hex")).toBe(fixture.source.sha256);
    expect(compactSolutionSummary(fixture.summary)).toBe(fixture.summary);
  });
});

describe("titles without phrase-specific interpretation", () => {
  it.each([
    ["Completed the requested task.\n\nUse native crypto.", "Completed the requested task."],
    ["Only on Linux:\n- Use native crypto.", "Completed solution"],
    ["**Handoff:**\n- Use native crypto.", "Completed solution"],
    ["# Warning\nUse v1.", "Completed solution"],
    ["```text\nUse v1.\n```", "Completed solution"],
    ["**Warning:** Use v1 only while offline.", "Warning: Use v1 only while offline."],
    ["仅在离线时使用本地缓存。\n必须校验签名。", "仅在离线时使用本地缓存。"],
    ["Review finished\nUse v1.", "Completed solution"],
    ["Only in this deployment ".repeat(10) + "use v1.\nUse v2.", "Completed solution"],
  ])("does not promote later statements past the opening context: %s", (summary, title) => {
    expect(solutionSummaryTitle(summary)).toBe(title);
    expect(compactSolutionSummary(summary)).toBe(summary);
  });
});

describe("exact title duplication", () => {
  it("keeps the entire body when its opening already represents the title", () => {
    expect(memoryTextWithoutDuplicateTitle('Use SHA-256.', 'Use SHA-256. Only for v2.')).toBe('Use SHA-256. Only for v2.');
    expect(memoryTextWithoutDuplicateTitle('Use SHA-256.', 'Use SHA-256.')).toBe('Use SHA-256.');
  });
  it("preserves titles that are only a substring or contain distinct scope", () => {
    expect(memoryTextWithoutDuplicateTitle('Use v1', 'Use v10.')).toBe('Use v1\nUse v10.');
    expect(memoryTextWithoutDuplicateTitle('Linux only', 'Use SHA-256.')).toBe('Linux only\nUse SHA-256.');
  });
});

describe("handoff preservation boundaries", () => {
  const handoff = 'Preserved for the next maintainer: Use native crypto.';
  it.each([
    `Completed the coordination-only change.\n\n- Ran \`npm test\`: passed, but only on Linux.\n\n${handoff}`,
    `Completed the coordination-only change.\n\n- Deleted only \`review.txt\`.\n  Only applies to the retired service.\n\n${handoff}`,
    `Completed the coordination-only change.\n\n- Deleted only \`review.txt\`.\n\nOnly for the retired service:\n${handoff}`,
    `Completed the coordination-only change.\n\n    ${handoff}`,
    `Completed the coordination-only change.\n\n\`\`\`md\n${handoff}\n\`\`\``,
    `Completed the coordination-only change.\n\n> ${handoff}`,
    `Completed the coordination-only change.\n\n**Handoff constraints to preserve for the retry-header follow-up:**\n\n**Verification:** Tests passed.`,
    `Completed the coordination-only change.\n\n- Preserved the approved implementation for the follow-up:\n- Tests passed: all 4 tests.`,
    `Completed the coordination-only change.\n\n${handoff}\n\n**Handoff constraints to preserve for the other follow-up:**\n- Use a library.`,
    `Completed the coordination-only change.\n\n- Deleted only \`review.txt\`. Rollback remains unverified.\n\n${handoff}`,
    `Completed the coordination-only change.\n\n- Ran \`npm test\`: passed only on Linux.\n\n${handoff}`,
    `Completed the coordination-only change.\n\n- Ran \`npm test\`: passed despite incompatibilities.\n\n${handoff}`,
    `    ${handoff}`,
    `\n    ${handoff}\n`,
  ])("keeps ambiguous context in place (%s)", (summary) => {
    expect(compactSolutionSummary(summary)).toBe(summary);
  });

  it("keeps a nested handoff's scope and following failed verification intact", () => {
    const summary = 'Completed the coordination-only change.\n\n- Deleted only `review.txt`.\n- Preserved the approved implementation for the follow-up:\n  - Only on Linux:\n    - Use native crypto.\n  - Keep the fallback on Windows.\n- Tests failed: 1 failure.\n- Remaining work: investigate Windows.';
    const expected = '- Preserved the approved implementation for the follow-up:\n  - Only on Linux:\n    - Use native crypto.\n  - Keep the fallback on Windows.\n- Tests failed: 1 failure.\n- Remaining work: investigate Windows.\n\n- Deleted only `review.txt`.';
    expect(compactSolutionSummary(summary)).toBe(summary);
    expect(compactSolutionSummary(expected)).toBe(expected);
  });
});
