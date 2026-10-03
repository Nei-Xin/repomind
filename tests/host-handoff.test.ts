import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureHostHandoff, prepareHostHandoff } from "../src/extraction/host-handoff.js";
import { analyzeOpenCodeOutcome } from "../src/integrations/opencode/lifecycle.js";
import { redactSecrets } from "../src/security/redaction.js";

const constraint = "Only on Linux, preserve exact bytes.";
const remaining = "Implementation remains outstanding.";
const prose = `Review closed.\n\n${constraint}\n\n${remaining}`;
const payload = { version: 1, constraints: [constraint], remainingWork: [remaining] };
const block = (json = JSON.stringify(payload)) => '```repomind-handoff\n' + json + '\n```';
const answer = `${prose}\n\n${block()}`;
const capture = (text: string) => captureHostHandoff(text, { finalAnswer: true, stdoutTruncated: false });
const prepare = (text: string) => prepareHostHandoff(text, capture(text));
const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const text = (value: string) => ({ type: "text", part: { text: value } });
const stop = { type: "step_finish", part: { reason: "stop" } };

describe("Host structured handoff protocol", () => {
  it("extracts only the terminal block while retaining exact full-answer Evidence coordinates", () => {
    const raw = ` \n${answer}\n \t`;
    const result = prepare(raw);
    expect(result).toMatchObject({ title: constraint, content: ` \n${prose}`, audit: { disposition: "accepted", producer: "opencode-host", rawHandoff: payload } });
    expect(result.audit.summarySha256).toBe(createHash("sha256").update(raw).digest("hex"));
    for (const p of [...result.audit.constraints, ...result.audit.remainingWork]) expect(raw.slice(p.start, p.end)).toBe(p.text);
  });

  it.each([
    ["malformed JSON", block('{"version":'), "invalid-json"],
    ["duplicate root key", block('{"version":2,"version":1,"constraints":[],"remainingWork":[]}'), "duplicate-json-key"],
    ["escaped duplicate key", block('{"version":1,"\\u0076ersion":1,"constraints":[],"remainingWork":[]}'), "duplicate-json-key"],
    ["nested duplicate", block('{"version":1,"constraints":[{"x":1,"x":2}],"remainingWork":[]}'), "duplicate-json-key"],
    ["unknown version", block(JSON.stringify({ ...payload, version: 2 })), "schema-invalid"],
    ["fake authority", block(JSON.stringify({ ...payload, verified: true })), "schema-invalid"],
    ["source substring", block(JSON.stringify({ ...payload, constraints: ["preserve exact bytes."] })), "not-whole-source-paragraph"],
    ["text after", block() + '\nExtra text.', "text-after-protocol"],
    ["two blocks", block() + '\n\n' + block(), "multiple-protocol-blocks"],
    ["indented", '  ' + block(), "unsupported-protocol-fence"],
    ["tab indented", '\t' + block(), "unsupported-protocol-fence"],
    ["quoted", '> ' + block(), "unsupported-protocol-fence"],
    ["tilde", block().replaceAll('```', '~~~'), "unsupported-protocol-fence"],
    ["unclosed", block().slice(0, -3), "unclosed-protocol-block"],
    ["oversize block", block(' '.repeat(8_000) + '{}'), "protocol-block-too-long"],
  ])("rejects %s with a bounded reason and no protocol exception", (_name, suffix, reason) => {
    const raw = `${prose}\n\n${suffix}`;
    expect(prepare(raw).audit).toMatchObject({ disposition: "rejected", reasonCodes: [reason], rawHandoff: null });
    expect(prepare(raw).content).toBe(raw);
  });

  it("does not interpret nested fenced examples as a handoff", () => {
    const example = `${prose}\n\n\`\`\`\`text\n${block()}\n\`\`\`\``;
    expect(prepare(example).audit.disposition).toBe("absent");
    expect(prepare(`${example}\n\n${block()}`).audit.disposition).toBe("accepted");
  });

  it("cannot match a claimed paragraph against the JSON itself", () => {
    const raw = `Review closed.\n\n${block()}`;
    expect(prepare(raw).audit.reasonCodes).toEqual(["not-whole-source-paragraph"]);
    expect(prepare(block()).audit.reasonCodes).toEqual(["missing-prose"]);
  });

  it("reports structural acceptance separately from unverified semantics", () => {
    const ambiguous = "Review closed.\n\nThe function supports empty, negative, and zero endpoints.";
    const raw = `${ambiguous}\n\n${block(JSON.stringify({
      version: 1,
      constraints: ["The function supports empty, negative, and zero endpoints."],
      remainingWork: [],
    }))}`;
    expect(prepare(raw).audit).toMatchObject({
      disposition: "accepted", semanticValidation: "not-performed", reasonCodes: [],
    });
    expect(prepare(raw).content).toBe(ambiguous);
  });

  it("requires collector offsets to match the actual answer", () => {
    const collected = capture(answer);
    expect(prepareHostHandoff(answer, { ...collected, block: { start: 0, end: 5 } }).audit.reasonCodes).toEqual(["protocol-range-mismatch"]);
    expect(prepareHostHandoff(prose, collected).audit.disposition).toBe("rejected");
  });

  it.each([
    [answer + "\u0000", "nul-in-summary"],
    ["x".repeat(12_001) + answer, "summary-too-long"],
  ])("records loss before sanitizing/clipping", (raw, reason) => {
    const outcome = analyzeOpenCodeOutcome(jsonl(text(raw), stop), "fallback", { structuredHandoff: true });
    expect(outcome.summary.length).toBeLessThanOrEqual(12_000);
    expect(outcome.summary).not.toContain("\u0000");
    expect(prepareHostHandoff(outcome.summary, outcome.handoff!).audit.reasonCodes).toContain(reason);
  });

  it("rebases spans after redaction and hashes the entire persisted answer", () => {
    const secret = "sk-" + "a".repeat(24);
    const raw = `Credential ${secret}.\n\n${answer}`;
    const prepared = prepare(raw);
    const persisted = redactSecrets(raw).content;
    expect(prepared.audit.disposition).toBe("accepted");
    expect(prepared.audit.summarySha256).toBe(createHash("sha256").update(persisted).digest("hex"));
    expect(persisted.slice(prepared.audit.constraints[0]!.start, prepared.audit.constraints[0]!.end)).toBe(constraint);
    expect(JSON.stringify(prepared.audit)).not.toContain(secret);
  });

  it.each([
    [text(answer), { type: "tool_use", part: { tool: "read", state: { output: answer } } }, stop],
    [text(answer), { type: "step_finish", part: { reason: "tool-calls" } }, stop],
    [{ type: "tool_use", part: { tool: "read", state: { output: answer } } }, stop],
    [text("Earlier fragment."), text(answer), stop],
    [text(answer), { type: "error", error: "provider failed" }, stop],
  ])("rejects unconfirmed or ambiguous final text events", (...events) => {
    const outcome = analyzeOpenCodeOutcome(jsonl(...events), "fallback", { structuredHandoff: true });
    expect(outcome.handoff!.rejectionReasons).toContain("unconfirmed-final-answer");
  });

  it("uses only the last confirmed final answer, and leaves disabled output unchanged", () => {
    const events = jsonl(text(answer), { type: "step_finish", part: { reason: "tool-calls" } }, text("Final prose only."), stop);
    const outcome = analyzeOpenCodeOutcome(events, "fallback", { structuredHandoff: true });
    expect(prepareHostHandoff(outcome.summary, outcome.handoff!).audit.disposition).toBe("absent");
    expect(analyzeOpenCodeOutcome(jsonl(text(answer), stop), "fallback")).not.toHaveProperty("handoff");
    const truncated = analyzeOpenCodeOutcome(jsonl(text(answer), stop), "fallback", { structuredHandoff: true, stdoutTruncated: true });
    expect(truncated.handoff!.rejectionReasons).toContain("output-truncated");
  });
});
