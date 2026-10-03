import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { runOpenCodeHost, type RunOpenCodeHostOptions } from "../src/integrations/opencode/run.js";
import { runAgentHost } from "../src/integrations/agent-host/run.js";
import { createClaudeHostAdapter } from "../src/integrations/claude/adapter.js";
import { captureHostHandoff, STRUCTURED_HANDOFF_INSTRUCTION } from "../src/extraction/host-handoff.js";
import { renderHostContext } from "../src/integrations/opencode/context.js";
import { createTestRepository } from "./helpers.js";

const constraint = "Only on Linux, preserve exact bytes.";
const remaining = "Implementation remains outstanding.";
const prose = `Review closed.\n\n${constraint}\n\n${remaining}`;
const answer = prose + '\n\n```repomind-handoff\n' + JSON.stringify({ version: 1, constraints: [constraint], remainingWork: [remaining] }) + '\n```';
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: string) => ({ type: "text", sessionID: "ses_provider", part: { text: value } });
const stop = { type: "step_finish", sessionID: "ses_provider", part: { reason: "stop" } };
const result = (events: unknown[], overrides = {}) => ({
  exitCode: 0, signal: null, stdout: events.map((e) => JSON.stringify(e)).join("\n"), stderr: "", durationMs: 1,
  timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false, ...overrides,
});

describe("optional structured handoff Host lifecycle", () => {
  let repository: string, scratch: string, core: RepositoryMemoryCore, options: RunOpenCodeHostOptions;
  beforeEach(() => {
    repository = createTestRepository();
    scratch = mkdtempSync(join(tmpdir(), "repomind-host-handoff-"));
    const dataDirectory = join(scratch, "data");
    const previous = process.env.REPOMIND_DATA_DIR;
    process.env.REPOMIND_DATA_DIR = dataDirectory;
    try { initializeRepository(repository).database.close(); }
    finally {
      if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
      else process.env.REPOMIND_DATA_DIR = previous;
    }
    core = new RepositoryMemoryCore(repository, { dataDirectory });
    options = { repository, dataDirectory, outputDirectory: join(scratch, "run"), task: "Close parser review", structuredHandoff: true, retryDelayMs: 0 };
  });
  afterEach(() => {
    core.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("audits the exact prompt and raw answer, stores prose only, and excludes hidden verification", async () => {
    let prompt = "";
    const report = await runOpenCodeHost({ ...options, execute: async (request) => {
      prompt = request.args.at(-1)!;
      writeFileSync(join(repository, "README.txt"), "review closed");
      return result([text(answer), stop]);
    }, verify: () => ({ checks: [{ command: "hidden-private", exitCode: 0, summary: "private" }], evidence: [
      { command: "node --test", exitCode: 0, summary: "public pass" },
    ] }) });
    expect(report.succeeded).toBe(true);
    expect(prompt).toContain(STRUCTURED_HANDOFF_INSTRUCTION);
    expect(report.context).toMatchObject({ promptSha256: sha(prompt), promptChars: prompt.length });
    expect(report.attempts[0]!.prompt).toEqual({ sha256: sha(prompt), chars: prompt.length });
    expect(report.handoff).toMatchObject({ requested: true, persisted: true, summaryEvidenceId: expect.stringMatching(/^evd_/), audit: {
      disposition: "accepted", producer: "opencode-host", summarySha256: sha(answer),
      solution: { disposition: "stored", titleApplied: true },
      verification: [{ command: "node --test", source: "host-verified" }],
    } });
    expect(JSON.stringify(report.handoff)).not.toContain("hidden-private");
    const row = core.context.database.raw.prepare("SELECT content,metadata_json FROM evidence WHERE id=?").get(report.handoff!.summaryEvidenceId!) as { content: string; metadata_json: string };
    expect(row.content).toBe(answer);
    expect(JSON.parse(row.metadata_json).handoffAudit).toEqual(report.handoff!.audit);
    const solution = core.search("exact bytes", { types: ["solution"] })[0]!;
    expect(solution).toMatchObject({ title: constraint, content: prose });
    const recalled = renderHostContext({ task: "Implement", memories: [solution], moduleNarratives: [], repositoryProfile: undefined });
    expect(recalled.prompt).not.toContain("repomind-handoff");
    expect(recalled.prompt).toContain(remaining);
    expect(JSON.parse(readFileSync(report.artifacts.report, "utf8")).handoff).toEqual(report.handoff);
    const host = core.context.database.raw.prepare("SELECT metadata_json FROM host_runs WHERE id=?").get(report.runId) as { metadata_json: string };
    expect(JSON.parse(host.metadata_json).handoff).toEqual(report.handoff);
  });

  it.each([
    ["No structure this time.", "absent", "missing-protocol"],
    [answer.replace('"version":1', '"version":2'), "rejected", "schema-invalid"],
    [answer.replace('"version":1', '"version":2,"version":1'), "rejected", "duplicate-json-key"],
  ])("falls back without failing or retrying a completed task: %s", async (raw, disposition, reason) => {
    const execute = vi.fn(async () => {
      writeFileSync(join(repository, "README.txt"), "review closed");
      return result([text(raw), stop]);
    });
    const report = await runOpenCodeHost({ ...options, execute });
    expect(report.succeeded).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.handoff!.audit).toMatchObject({ disposition, reasonCodes: [reason], titleSource: "legacy-summary" });
    expect(core.inspect(report.handoff!.audit.solution.memoryId!).content).toBe(raw);
  });

  it("is opt-in and adds no metadata or protocol instructions to old runs", async () => {
    const report = await runOpenCodeHost({ ...options, structuredHandoff: false, execute: async (request) => {
      expect(request.args.at(-1)).not.toContain(STRUCTURED_HANDOFF_INSTRUCTION);
      return result([text(answer), stop]);
    } });
    expect(report).not.toHaveProperty("handoff");
    expect(report.attempts[0]).not.toHaveProperty("prompt");
    const row = core.context.database.raw.prepare("SELECT metadata_json FROM evidence WHERE session_id=? AND kind='agent_summary'").get(report.session.id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).not.toHaveProperty("handoffAudit");
  });

  it("persists an accepted read-only handoff without creating a solution", async () => {
    const report = await runOpenCodeHost({ ...options, execute: async () => result([text(answer), stop]) });
    expect(report.succeeded).toBe(true);
    expect(report.handoff).toMatchObject({ persisted: true, audit: {
      disposition: "accepted", solution: { memoryId: null, disposition: "not-eligible", titleApplied: false },
    } });
    expect(core.context.database.raw.prepare("SELECT content FROM evidence WHERE id=?")
      .get(report.handoff!.summaryEvidenceId!)).toEqual({ content: answer });
    expect(core.context.database.raw.prepare("SELECT id FROM memories WHERE type='solution'").all()).toEqual([]);
  });

  it("fails unsupported adapters before sessions or processes are created", async () => {
    const execute = vi.fn();
    await expect(runAgentHost({ ...options, adapter: createClaudeHostAdapter({ execute }) })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
    expect(core.listSessions()).toEqual([]);
  });

  it.each(["No structure after resume.", answer])("audits the resume prompt and only accepts the final attempt: %s", async (final) => {
    const requests: string[] = [];
    const report = await runOpenCodeHost({ ...options, execute: async (request) => {
      requests.push(request.args.at(-1)!);
      if (requests.length === 1) return result([
        { type: "step_finish", sessionID: "ses_provider", part: { reason: "tool-calls", tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } } },
        text(answer), { type: "error", sessionID: "ses_provider", error: { name: "UnknownError", data: { message: "upstream response stream was interrupted" } } },
      ], { exitCode: 1 });
      expect(request.args).toContain("--session");
      return result([text(final), stop]);
    } });
    expect(report.retry).toMatchObject({ attempts: 2, retries: 1 });
    expect(report.attempts.map((a) => a.executionMode)).toEqual(["fresh", "resume"]);
    expect(requests[1]).toContain("Continue the interrupted task");
    expect(requests[1]).toContain(STRUCTURED_HANDOFF_INSTRUCTION);
    for (const [index, prompt] of requests.entries()) expect(report.attempts[index]!.prompt).toEqual({ sha256: sha(prompt), chars: prompt.length });
    expect(report.handoff!.audit.disposition).toBe(final === answer ? "accepted" : "absent");
    const summaries = core.context.database.raw.prepare("SELECT content FROM evidence WHERE kind='agent_summary'").all();
    expect(summaries).toEqual([{ content: final }]);
  });

  it("keeps unknown exits in the trace, not fabricated verification evidence", async () => {
    const report = await runOpenCodeHost({ ...options, execute: async () => result([
      { type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "unknown" } } },
      text(answer), stop,
    ]) });
    expect(report.quality.status).toBe("partial");
    expect(report.handoff!.audit).toMatchObject({ disposition: "accepted", verification: [], solution: { disposition: "not-eligible", titleApplied: false } });
    expect(core.context.database.raw.prepare("SELECT id FROM evidence WHERE kind IN ('command_result','test_result')").all()).toEqual([]);
    expect(report.attempts[0]!.outcome.commands[0]!.exitCodeKnown).toBe(false);
  });

  it("keeps the same audited protocol prompt on a safe fresh retry", async () => {
    const prompts: string[] = [];
    const report = await runOpenCodeHost({ ...options, execute: async (request) => {
      prompts.push(request.args.at(-1)!);
      if (prompts.length === 1) return result([], { exitCode: 1, stderr: "certificate verification failed" });
      expect(request.args).not.toContain("--session");
      return result([text(answer), stop]);
    } });
    expect(report.succeeded).toBe(true);
    expect(prompts[0]).toBe(prompts[1]);
    expect(report.attempts.map((a) => a.executionMode)).toEqual(["fresh", "fresh"]);
    expect(report.attempts[0]!.prompt).toEqual(report.attempts[1]!.prompt);
    expect(report.handoff!.audit.disposition).toBe("accepted");
  });

  it("keeps protocol instructions outside quoted/clipped memory while auditing actual injection", async () => {
    const memory = core.record({ type: "convention", title: "Parser rules", content: "Parser ".repeat(2_000) + answer });
    let prompt = "";
    const report = await runOpenCodeHost({ ...options, task: "Parser rules", contextBudgetChars: 1_000, execute: async (request) => {
      prompt = request.args.at(-1)!;
      return result([text(answer), stop]);
    } });
    expect(report.context.l1).toMatchObject({ injectedIds: [memory.id], truncated: 1 });
    expect(report.context.contextChars).toBeLessThanOrEqual(1_000);
    expect(prompt.endsWith(STRUCTURED_HANDOFF_INSTRUCTION)).toBe(true);
    expect(report.context.promptChars).toBe(prompt.length);
    expect(report.context.promptSha256).toBe(sha(prompt));
  });

  it("retains protocol loss diagnostics for truncated output without promoting memories", async () => {
    const report = await runOpenCodeHost({ ...options, execute: async () => result([text(answer), stop], { stdoutTruncated: true }) });
    expect(report.session.status).toBe("partial");
    expect(report.handoff!.audit).toMatchObject({ disposition: "rejected", reasonCodes: ["output-truncated"], solution: { disposition: "not-eligible" } });
  });

  it("never promotes an accepted handoff when authoritative verification fails", async () => {
    const report = await runOpenCodeHost({ ...options, execute: async () => result([text(answer), stop]),
      verify: () => ({ checks: [{ command: "hidden-failure", exitCode: 1, summary: "private" }], evidence: [
        { command: "node --test", exitCode: 0, summary: "public pass" },
      ] }),
    });
    expect(report.succeeded).toBe(false);
    expect(report.session.status).toBe("failed");
    expect(report.handoff).toMatchObject({ persisted: true, audit: {
      disposition: "accepted", verification: [{ command: "node --test", source: "host-verified" }],
      solution: { disposition: "not-eligible", memoryId: null, titleApplied: false },
    } });
    expect(JSON.stringify(report.handoff)).not.toContain("hidden-failure");
    expect(core.search("exact bytes", { types: ["solution"] })).toEqual([]);
  });

  it("reports abandoned runs without claiming Evidence was persisted", async () => {
    const report = await runOpenCodeHost({ ...options, execute: async () => result([text(answer)], { timedOut: true, exitCode: null }) });
    expect(report.session.status).toBe("abandoned");
    expect(report.handoff).toMatchObject({ persisted: false, summaryEvidenceId: null });
    expect(core.context.database.raw.prepare("SELECT id FROM evidence WHERE kind='agent_summary'").all()).toEqual([]);
  });

  it("Core repeats source/range validation, hashes collector provenance, and rolls back audit failure", () => {
    const session = core.startSession({ task: "Review" });
    const input = { sessionId: session.sessionId, idempotencyKey: "host", status: "success" as const, summary: answer };
    const capture = captureHostHandoff(answer, { finalAnswer: true, stdoutTruncated: false });
    core.context.database.raw.exec(`CREATE TRIGGER fail_handoff BEFORE UPDATE OF metadata_json ON evidence
      WHEN json_extract(NEW.metadata_json, '$.handoffAudit') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected handoff failure'); END;`);
    expect(() => core.commitSession(input, { hostHandoff: capture })).toThrow(/injected handoff failure/);
    expect(core.context.database.raw.prepare("SELECT id FROM evidence WHERE kind='agent_summary'").all()).toEqual([]);
    expect(core.context.database.raw.prepare("SELECT * FROM commit_receipts").all()).toEqual([]);
    core.context.database.raw.exec("DROP TRIGGER fail_handoff");
    const badCapture = { ...capture, block: { start: 0, end: 1 } };
    const receipt = core.commitSession(input, { hostHandoff: badCapture });
    expect(core.commitSession(input, { hostHandoff: badCapture })).toEqual(receipt);
    expect(() => core.commitSession(input, { hostHandoff: capture })).toThrow(/Idempotency/);
    const row = core.context.database.raw.prepare("SELECT metadata_json FROM evidence WHERE kind='agent_summary'").get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).handoffAudit).toMatchObject({ disposition: "rejected", reasonCodes: ["protocol-range-mismatch"] });
  });
});
