import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureHostHandoff, prepareHostHandoff } from "../src/extraction/host-handoff.js";
import { redactSecrets } from "../src/security/redaction.js";

const block = (value: unknown) => '\n\n```repomind-handoff\n' + JSON.stringify(value) + '\n```';
const select = (constraints: number[], remainingWork: number[] = []) => ({ version: 2, constraints, remainingWork });
const prepare = (answer: string) => prepareHostHandoff(answer, captureHostHandoff(answer, { finalAnswer: true, stdoutTruncated: false }));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/handoff-partial-paragraph.json', import.meta.url), 'utf8')) as { summary: string; sha256: string };

describe('Host paragraph-reference handoffs', () => {
  it('retains the original real failure and accepts whole-paragraph references without changing its prose', () => {
    expect(createHash('sha256').update(fixture.summary).digest('hex')).toBe(fixture.sha256);
    expect(prepare(fixture.summary).audit).toMatchObject({ disposition: 'rejected', reasonCodes: ['not-whole-source-paragraph'] });
    const prose = fixture.summary.split('\n\n```repomind-handoff')[0]!;
    const selection = select([2, 3, 4, 5, 6], [7]);
    const result = prepare(prose + block(selection));
    expect(result.content).toBe(prose);
    expect(result.audit).toMatchObject({ disposition: 'accepted', protocolVersion: 2, rawHandoff: selection, semanticValidation: 'not-performed' });
    expect(result.audit.remainingWork[0]!.text).toBe(prose.split('\n\n')[6]);
    expect(result.audit.remainingWork[0]!.text).toContain('`npm test` passed');
    expect(result.audit.verification).toEqual([]);
  });

  it('counts CRLF, blank whitespace lines, headings and multiline paragraphs without detaching conditions', () => {
    const paragraph = 'Only while offline:\r\n- Keep the cached value.\r\n- Do not retry.';
    const prose = ` \r\n# Review\r\n\t\r\n${paragraph}\r\n\r\n仍待完成。`;
    const raw = prose + block(select([2], [3]));
    const result = prepare(raw);
    expect(result.audit.disposition).toBe('accepted');
    expect(result.audit.constraints[0]!.text).toBe(paragraph);
    for (const p of [...result.audit.constraints, ...result.audit.remainingWork]) expect(raw.slice(p.start, p.end)).toBe(p.text);
    expect(result.content).toBe(prose);
  });

  it.each([
    [select([0]), 'schema-invalid'], [select([-1]), 'schema-invalid'], [select([1.5]), 'schema-invalid'],
    [{ version: 2, constraints: ['1'], remainingWork: [] }, 'schema-invalid'],
    [select([1, 1]), 'schema-invalid'],
    [select([2, 1]), 'source-order-mismatch'], [select([3]), 'paragraph-reference-out-of-range'],
    [{ ...select([1]), verified: true }, 'schema-invalid'],
    [select(Array.from({ length: 17 }, (_, i) => i + 1)), 'schema-invalid'],
  ])('rejects invalid selection %j', (selection, reason) => {
    expect(prepare('First.\n\nSecond.' + block(selection)).audit).toMatchObject({ disposition: 'rejected', reasonCodes: [reason] });
  });

  it('allows one complete paragraph to carry both a rule and its remaining work', () => {
    const prose = 'Review.\n\nThe rule and its follow-up remain in this one paragraph.';
    const result = prepare(prose + block(select([2], [2])));
    expect(result.audit).toMatchObject({ disposition: 'accepted', constraints: [{ text: prose.split('\n\n')[1] }], remainingWork: [{ text: prose.split('\n\n')[1] }] });
  });

  it('retains v1 size and ambiguous-source checks after expansion', () => {
    expect(prepare('x'.repeat(2001) + block(select([1]))).audit.reasonCodes).toEqual(['schema-invalid']);
    expect(prepare(['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(1500)].join('\n\n') + block(select([1, 2, 3]))).audit.reasonCodes).toEqual(['total-length-exceeded']);
    expect(prepare('Same.\n\nSame.' + block(select([1]))).audit.reasonCodes).toEqual(['ambiguous-source-paragraph']);
  });

  it('rebases redacted spans and rejects source collapse', () => {
    const a = 'sk-' + 'a'.repeat(24), b = 'sk-' + 'b'.repeat(24);
    const raw = `Credential ${a}.\n\nKeep exact bytes.` + block(select([2]));
    const result = prepare(raw), persisted = redactSecrets(raw).content;
    expect(result.audit.disposition).toBe('accepted');
    const p = result.audit.constraints[0]!;
    expect(persisted.slice(p.start, p.end)).toBe(p.text);
    expect(result.audit.summarySha256).toBe(createHash('sha256').update(persisted).digest('hex'));
    expect(prepare(`${a}\n\n${b}` + block(select([1]))).audit.reasonCodes).toEqual(['redacted-source-mismatch']);
  });

  it('keeps v2 paragraph numbers valid when a selected paragraph is redacted', () => {
    const secret = 'sk-' + 'a'.repeat(24);
    const prose = `Review.\n\nPreserve ${secret} only in the private source.`;
    const result = prepare(prose + block(select([2])));
    expect(result.audit.disposition).toBe('accepted');
    expect(result.audit.rawHandoff).toEqual(select([2]));
    expect(result.audit.constraints[0]!.text).not.toContain(secret);
  });

  it('preserves all prose with empty annotations and rejects loss before resolving references', () => {
    expect(prepare('Notes.\n\nWarning: obsolete.' + block(select([]))).content).toBe('Notes.\n\nWarning: obsolete.');
    const raw = 'Notes.' + block(select([1]));
    expect(prepareHostHandoff(raw, captureHostHandoff(raw, { finalAnswer: true, stdoutTruncated: true })).audit.reasonCodes).toContain('output-truncated');
    expect(prepareHostHandoff(raw, { requested: true, rejectionReasons: [], block: { start: 0, end: 1 } }).audit.reasonCodes).toEqual(['protocol-range-mismatch']);
  });
});
