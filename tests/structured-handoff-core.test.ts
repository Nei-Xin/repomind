import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import type { CommitSessionInput, StructuredHandoffV1 } from "../src/domain/types.js";
import type { ExplicitHandoffAudit } from "../src/extraction/structured-handoff.js";
import { initializeRepository } from "../src/repository.js";
import { renderHostContext } from "../src/integrations/opencode/context.js";
import { renderInteractiveRecall } from "../src/activity/context.js";
import { redactSecrets } from "../src/security/redaction.js";
import { createTestRepository } from "./helpers.js";

describe("structured handoff persistence", () => {
  let repository: string, data: string, core: RepositoryMemoryCore;
  const constraint = "Warning: only on Linux, preserve case-sensitive path matching.";
  const remaining = "Implementation in future.ts remains outstanding.";
  const summary = `\nCompleted the review closeout.\n\n${constraint}\n\nTests passed.\n\n${remaining}\n`;
  const handoff: StructuredHandoffV1 = { version: 1, constraints: [constraint], remainingWork: [remaining] };
  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-handoff-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
    core = new RepositoryMemoryCore(repository);
  });
  afterEach(() => {
    core.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });
  const input = (sessionId: string): CommitSessionInput => ({ sessionId, idempotencyKey: "handoff", status: "success", summary, handoff });
  const audit = (sessionId: string) => {
    const row = core.context.database.raw.prepare("SELECT id,content,metadata_json FROM evidence WHERE session_id=? AND kind='agent_summary'")
      .get(sessionId) as { id: string; content: string; metadata_json: string };
    return { ...row, metadata: JSON.parse(row.metadata_json) as { remainingWork: string[]; handoffAudit: ExplicitHandoffAudit } };
  };
  const snapshot = () => Object.fromEntries(["evidence", "memories", "memory_evidence", "memory_fts", "commit_receipts", "sessions"].map((table) => [
    table, core.context.database.raw.prepare(`SELECT * FROM ${table}`).all(),
  ]));

  it("persists exact prose and source spans, recalls a scoped title, and retries idempotently", () => {
    writeFileSync(join(repository, "dirty.txt"), "pre-existing edit");
    const session = core.startSession({ task: "Close the review" });
    writeFileSync(join(repository, "README.txt"), "closed");
    const request = input(session.sessionId);
    const result = core.commitSession(request);
    const beforeRetry = snapshot();
    expect(core.commitSession(request)).toEqual(result);
    expect(snapshot()).toEqual(beforeRetry);
    const row = audit(session.sessionId);
    expect(row.content).toBe(summary);
    expect(row.metadata.remainingWork).toEqual([remaining]);
    expect(row.metadata.handoffAudit).toMatchObject({
      disposition: "accepted", producer: "explicit-input", rawHandoff: handoff,
      summarySha256: createHash("sha256").update(summary).digest("hex"), verification: [],
      titleSource: "structured-constraint", solution: { disposition: "stored", titleApplied: true },
    });
    for (const p of [...row.metadata.handoffAudit.constraints, ...row.metadata.handoffAudit.remainingWork]) {
      expect(row.content.slice(p.start, p.end)).toBe(p.text);
    }
    const solution = core.search("case-sensitive", { types: ["solution"] })[0]!;
    expect(solution).toMatchObject({ title: constraint, content: summary });
    expect(core.context.database.raw.prepare("SELECT file_path FROM memory_files WHERE memory_id=?").all(solution.id))
      .toEqual([{ file_path: "README.txt" }]);
    expect(core.context.database.raw.prepare("SELECT type FROM memories WHERE type IN ('command','decision','requirement')").all()).toEqual([]);
    expect(row.metadata.handoffAudit.solution.memoryId).toBe(solution.id);
    const host = renderHostContext({ task: "Implement parser", memories: [solution], moduleNarratives: [], repositoryProfile: undefined });
    expect(host.prompt).toContain(`> ${constraint}`);
    expect(host.prompt).toContain(remaining);
    expect(host.stats.l1.injectedIds).toEqual([solution.id]);
    expect(host.stats.promptSha256).toBe(createHash("sha256").update(host.prompt).digest("hex"));
    const interactive = renderInteractiveRecall([solution]);
    expect(interactive.recall.memoryIds).toEqual([solution.id]);
    expect(interactive.recall.contextChars).toBe(interactive.context.length);
    expect(interactive.recall.contextSha256).toBe(createHash("sha256").update(interactive.context).digest("hex"));
    expect(() => core.commitSession({ ...request, handoff: { ...handoff, constraints: [] } })).toThrow(/Idempotency/);
    expect(snapshot()).toEqual(beforeRetry);
  });

  it.each([
    null,
    { ...handoff, verified: true },
    { ...handoff, constraints: ["preserve case-sensitive path matching."] },
    { ...handoff, constraints: ["Never mentioned."] },
  ])("rejects direct Core input before any writes: %j", (invalid) => {
    const session = core.startSession({ task: "Close review" });
    const before = snapshot();
    expect(() => core.commitSession({ ...input(session.sessionId), handoff: invalid as StructuredHandoffV1 }))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(snapshot()).toEqual(before);
  });

  it("rejects conflicting legacy remaining work and accepts the identical array", () => {
    const session = core.startSession({ task: "Close review" });
    const before = snapshot();
    expect(() => core.commitSession({ ...input(session.sessionId), remainingWork: [] })).toThrow();
    expect(snapshot()).toEqual(before);
    expect(core.commitSession({ ...input(session.sessionId), remainingWork: [remaining] }).status).toBe("committed");
  });

  it.each(["caller-reported", "tool-observed", "host-verified"] as const)("projects persisted verification with %s provenance", (source) => {
    const session = core.startSession({ task: "Verify parser" });
    const tests = [{ command: "npm test", exitCode: 1, summary: "failed" }, { command: "npm test", exitCode: 0, summary: "passed" }];
    const commands = [{ command: "rg absent", exitCode: 1, summary: "no match" }];
    core.commitSession({ ...input(session.sessionId), tests, commands }, { tests: source, commands: source });
    const verification = audit(session.sessionId).metadata.handoffAudit.verification;
    expect(verification.map(({ command, exitCode, source: recorded }) => ({ command, exitCode, source: recorded })))
      .toEqual([...tests, ...commands].map(({ command, exitCode }) => ({ command, exitCode, source })));
    for (const item of verification) {
      const evidence = core.context.database.raw.prepare("SELECT session_id,content,metadata_json FROM evidence WHERE id=?").get(item.evidenceId) as { session_id: string; content: string; metadata_json: string };
      expect(evidence.session_id).toBe(session.sessionId);
      expect(JSON.parse(evidence.content)).toMatchObject({ command: item.command, exitCode: item.exitCode });
      expect(JSON.parse(evidence.metadata_json).verificationSource).toBe(source);
    }
    const memory = core.context.database.raw.prepare("SELECT title,tags_json FROM memories WHERE type='command'").get() as { title: string; tags_json: string };
    expect(memory.title).toContain(source === "caller-reported" ? "Reported successful command" : "Verified command");
    const second = core.startSession({ task: "Verify parser again" });
    const repeat = core.commitSession({ ...input(second.sessionId), tests: [tests[1]!] }, { tests: source });
    if (source !== "caller-reported") expect(repeat.memories.revalidated).toBe(1);
    expect(core.context.database.raw.prepare("SELECT count(*) n FROM memories WHERE type='command'").get()).toEqual({ n: 1 });
  });

  it.each(["partial", "failed"] as const)("retains handoff evidence without storing a solution for %s", (status) => {
    const session = core.startSession({ task: "Close review" });
    writeFileSync(join(repository, "README.txt"), "changed");
    core.commitSession({ ...input(session.sessionId), status });
    expect(core.context.database.raw.prepare("SELECT * FROM memories").all()).toEqual([]);
    expect(audit(session.sessionId).metadata.handoffAudit.solution).toEqual({ memoryId: null, disposition: "not-eligible", titleApplied: false });
  });

  it("keeps repository-outcome gating for read-only work and deletion-only work", () => {
    const readOnly = core.startSession({ task: "Explain review" });
    core.commitSession(input(readOnly.sessionId), { solutionPolicy: "repository-outcome" });
    expect(audit(readOnly.sessionId).metadata.handoffAudit.solution.disposition).toBe("not-eligible");
    const deletion = core.startSession({ task: "Close review" });
    rmSync(join(repository, "README.txt"));
    core.commitSession(input(deletion.sessionId), { solutionPolicy: "repository-outcome" });
    expect(audit(deletion.sessionId).metadata.handoffAudit.solution.disposition).toBe("stored");
    expect(core.context.database.raw.prepare("SELECT * FROM memory_files").all()).toEqual([]);
  });

  it("does not rewrite a deduplicated old memory or claim that its title changed", () => {
    const first = core.startSession({ task: "Review" });
    const { handoff: _handoff, ...legacy } = input(first.sessionId);
    const receipt = core.commitSession(legacy);
    const old = core.context.database.raw.prepare("SELECT id,title,content FROM memories WHERE type='solution'").get();
    const second = core.startSession({ task: "Review again" });
    core.commitSession(input(second.sessionId));
    expect(core.context.database.raw.prepare("SELECT id,title,content FROM memories WHERE type='solution'").all()).toEqual([old]);
    expect(audit(second.sessionId).metadata.handoffAudit.solution).toMatchObject({ disposition: "deduplicated", titleApplied: false });
    expect(audit(first.sessionId).metadata).not.toHaveProperty("handoffAudit");
    const beforeRetry = snapshot();
    expect(core.commitSession(legacy)).toEqual(receipt);
    expect(snapshot()).toEqual(beforeRetry);
  });

  it("does not revive a retired memory or report it as a linked duplicate", () => {
    const first = core.startSession({ task: "Review" });
    core.commitSession(input(first.sessionId));
    const id = audit(first.sessionId).metadata.handoffAudit.solution.memoryId!;
    core.invalidateMemory({ memoryId: id, reason: "Contract no longer applies." });
    const second = core.startSession({ task: "Review again" });
    core.commitSession(input(second.sessionId));
    const row = audit(second.sessionId);
    expect(row.metadata.handoffAudit.solution).toEqual({ memoryId: id, disposition: "skipped-retired", titleApplied: false });
    expect(core.inspect(id).status).toBe("invalid");
    expect(core.context.database.raw.prepare("SELECT 1 FROM memory_evidence WHERE memory_id=? AND evidence_id=?").get(id, row.id)).toBeUndefined();
  });

  it("bypasses legacy compaction even for a supported layout with empty annotations", () => {
    const session = core.startSession({ task: "Close review" });
    const prose = "Completed the coordination-only change.\n\nDeleted only `ops/review.txt`.\n\nPreserved decision for the next maintainer: Preserve bytes.";
    core.commitSession({ ...input(session.sessionId), summary: prose, handoff: { version: 1, constraints: [], remainingWork: [] } });
    expect(core.context.database.raw.prepare("SELECT content FROM memories WHERE type='solution'").get()).toEqual({ content: prose });
    expect(audit(session.sessionId).metadata.handoffAudit).toMatchObject({ titleSource: "legacy-summary", verification: [], solution: { titleApplied: false } });
  });

  it("rolls back all evidence and memories if the audit update fails", () => {
    const session = core.startSession({ task: "Review" });
    const before = snapshot();
    core.context.database.raw.exec(`CREATE TRIGGER reject_handoff BEFORE UPDATE OF metadata_json ON evidence
      WHEN json_extract(NEW.metadata_json, '$.handoffAudit') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
    expect(() => core.commitSession(input(session.sessionId))).toThrow(/audit failure/);
    expect(snapshot()).toEqual(before);
    core.context.database.raw.exec("DROP TRIGGER reject_handoff");
    expect(core.commitSession(input(session.sessionId)).status).toBe("committed");
  });

  it("persists redacted source positions without leaking secret copies in audit metadata", () => {
    const session = core.startSession({ task: "Review" });
    const secret = "sk-" + "a".repeat(24);
    const raw = `Credential ${secret}.\n\n${constraint}`;
    core.commitSession({ ...input(session.sessionId), summary: raw, handoff: { version: 1, constraints: [constraint], remainingWork: [] } });
    const row = audit(session.sessionId);
    expect(row.content).toBe(redactSecrets(raw).content);
    expect(row.metadata_json).not.toContain(secret);
    const p = row.metadata.handoffAudit.constraints[0]!;
    expect(row.content.slice(p.start, p.end)).toBe(constraint);
    expect(row.metadata.handoffAudit.summarySha256).toBe(createHash("sha256").update(row.content).digest("hex"));
  });
});
