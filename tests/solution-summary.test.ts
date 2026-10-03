import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactSolutionSummary, memoryTextWithoutDuplicateTitle, solutionSummaryTitle } from "../src/extraction/solution-summary.js";

describe("solution summary layout", () => {
  it("puts an explicit handoff ahead of session bookkeeping without losing evidence or limitations", () => {
    const status = '- Deleted only `ops/review.txt`.\n- Ran `npm test`: **4 passed, 0 failed**.\n- Did not implement the follow-up.';
    const facts = 'Use `node:crypto` with no third-party dependencies. Hash UTF-8 as lowercase SHA-256 hex.\n\nRemaining work: implement the function; Windows is unverified.';
    const original = `Completed the coordination-only change.\n\n${status}\n\nPreserved decision for the next maintainer: ${facts}`;
    const result = compactSolutionSummary(original);
    expect(result).toBe(`${facts}\n\n${status}`);
    expect(compactSolutionSummary(result)).toBe(result);
  });

  it("preserves a list's scope, rejected options, exact strings and negative constraints", () => {
    const heading = 'Durable Gateway compatibility constraints for the next maintainer:';
    const facts = '- Only for Gateway v2.\n- `x-limit` must be the string "4".\n- `/v1/jobs` is retired; `/v2/jobs` was never deployed.\n- Integers 0–4 only; reject everything else with RangeError.';
    expect(compactSolutionSummary(`Completed the coordination-only cleanup.\n\n- Left other files unchanged.\n\n${heading}\n\n${facts}`))
      .toBe(`${heading}\n\n${facts}\n\n- Left other files unchanged.`);
  });

  it("supports explicit Chinese handoffs without replacing a fact with an inferred title", () => {
    const facts = '交接约束：\n\n- 仅在缓存为空时重试。\n- 保留原始异常的 cause。';
    expect(compactSolutionSummary(`已完成协调清理。\n\n- 仅删除 review.txt。\n\n${facts}`))
      .toBe(`${facts}\n\n- 仅删除 review.txt。`);
  });

  it("keeps a subject-bearing inline heading rather than dropping its scope", () => {
    const handoff = 'Durable legacy Gateway constraints for the next maintainer: Only retry once.';
    expect(compactSolutionSummary(`Completed the requested task.\n\n${handoff}`)).toBe(handoff);
  });

  it.each([
    'Implemented the cache. The legacy endpoint remains supported.',
    'Completed the requested task.\n\nNo durable decision was recorded.',
    'Completed the requested task.\n\nWarning: the following decision is obsolete.\n\nPreserved decision for the next maintainer: Use v1.',
    'Completed the requested task.\n\n- Only on Linux:\n\nPreserved decision for the next maintainer: Use native crypto.',
    'Completed the requested task.\n\n```text\nPreserved decision for the next maintainer: fake\n```',
    'Completed the requested task.\n\n> Preserved decision for the next maintainer: quoted',
    'Completed the requested task.\n\nPreserved decision for the next maintainer:',
    'Completed the requested task.\n\nPreserved decision for the next maintainer: A.\n\nPreserved decision for the next maintainer: B.',
  ])("leaves ambiguous or unsupported layouts unchanged (%s)", (summary) => {
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

const handoffs = JSON.parse(readFileSync(new URL("./fixtures/solution-handoffs.json", import.meta.url), "utf8")) as Array<{
  id: string; source: { sha256: string }; summary: string; expectedContent: string; expectedTitle: string;
}>;
const heldoutHandoffs = JSON.parse(readFileSync(new URL("./fixtures/solution-handoffs-heldout.json", import.meta.url), "utf8")) as typeof handoffs;

describe("real OpenCode handoff regressions", () => {
  it.each(handoffs)("preserves the complete handoff and bookkeeping for $id", (fixture) => {
    expect(createHash("sha256").update(fixture.summary).digest("hex")).toBe(fixture.source.sha256);
    const result = compactSolutionSummary(fixture.summary);
    expect(result).toBe(fixture.expectedContent);
    expect(solutionSummaryTitle(result)).toBe(fixture.expectedTitle);
    expect(compactSolutionSummary(result)).toBe(result);
  });
});

describe("held-out OpenCode handoff regressions", () => {
  it.each(heldoutHandoffs)("covers the previously unseen layout $id", (fixture) => {
    expect(createHash("sha256").update(fixture.summary).digest("hex")).toBe(fixture.source.sha256);
    expect(compactSolutionSummary(fixture.summary)).toBe(fixture.expectedContent);
    expect(solutionSummaryTitle(fixture.expectedContent)).toBe(fixture.expectedTitle);
    expect(compactSolutionSummary(fixture.expectedContent)).toBe(fixture.expectedContent);
  });

  it("retains inline warning and scope labels in titles", () => {
    expect(solutionSummaryTitle('**Warning:** Use v1 only while offline.')).toContain('Warning:');
    expect(solutionSummaryTitle('**Linux only:** Use native crypto.')).toContain('Linux only:');
  });

  it.each([
    'Completed the coordination-only ETag migration closeout, except validation.',
    'Completed the coordination-only ETag migration closeout. Windows is unverified.',
    'Completed the implementation and migration closeout.',
  ])("retains substantive completion statements (%s)", (opening) => {
    const summary = `${opening}\n\n- Durable contract for the follow-up:\n  - Use native crypto.`;
    expect(compactSolutionSummary(summary)).toBe(summary);
  });

  it("does not move a contract ahead of a new warning layout", () => {
    const summary = 'Completed the coordination-only trace migration closeout.\n\n**Warning:** This contract is obsolete.\n\n**Durable contract for the follow-up:** Use v1.';
    expect(compactSolutionSummary(summary)).toBe(summary);
    expect(solutionSummaryTitle(summary)).toContain('Warning:');
  });
});

describe("solution title boundaries", () => {
  it("skips generic completion without skipping a warning or changing the body", () => {
    const summary = 'Completed the coordination-only change.\n\nWarning: v1 is obsolete.\n\nPreserved for the next maintainer: Use v1.';
    expect(compactSolutionSummary(summary)).toBe(summary);
    expect(solutionSummaryTitle(summary)).toBe('Warning: v1 is obsolete.');
  });

  it("does not promote a statement out of a warning or conditional heading", () => {
    expect(solutionSummaryTitle('Completed the requested task.\n\n**Warning:**\n- Use v1.')).toBe('Completed solution');
    expect(solutionSummaryTitle('Only on Linux:\n- Use native crypto.')).toBe('Completed solution');
  });

  it("improves the title even when the body has no recognized handoff", () => {
    const summary = 'Completed the requested task.\n\nUse native crypto.';
    expect(compactSolutionSummary(summary)).toBe(summary);
    expect(solutionSummaryTitle(summary)).toBe('Use native crypto.');
  });

  it("skips emphasized headings but retains a complete constraint sentence", () => {
    expect(solutionSummaryTitle('**Handoff:**\n- `x-limit` is the string "4". Other limits are unsupported.'))
      .toBe('`x-limit` is the string "4".');
  });

  it("never clips or skips an overlong first statement to select a later fact", () => {
    expect(solutionSummaryTitle(`${'Only in this deployment '.repeat(10)}use v1.\nUse v2.`)).toBe('Completed solution');
    expect(solutionSummaryTitle('Completed the coordination-only change.')).toBe('Completed solution');
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
    expect(compactSolutionSummary(summary)).toBe(expected);
    expect(compactSolutionSummary(expected)).toBe(expected);
  });
});
