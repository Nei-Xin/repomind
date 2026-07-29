import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import type { CommitSessionInput } from "../src/domain/types.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

function finish(
  core: RepositoryMemoryCore,
  task: string,
  key: string,
  status: CommitSessionInput["status"] = "success",
): string {
  const started = core.startSession({ task, clientName: "vitest", clientSessionId: key });
  core.commitSession({
    sessionId: started.sessionId,
    idempotencyKey: key,
    status,
    summary: `${task} completed with the documented release checks.`,
    commands: [
      { command: "npm publish --dry-run", exitCode: 1, summary: "Registry access was unavailable." },
      { command: "node D:\\private\\repo\\scripts\\release.js /root/private/release.json", exitCode: 0, summary: "Build completed." },
    ],
    tests: [{ command: "npm test", exitCode: 0, summary: "All tests passed." }],
  });
  return started.sessionId;
}

describe("L4 Skill Candidates", () => {
  let repository: string;
  let otherRepository: string;
  let data: string;
  let artifacts: string;

  beforeEach(() => {
    repository = createTestRepository("repomind-l4-");
    otherRepository = createTestRepository("repomind-l4-other-");
    data = mkdtempSync(join(tmpdir(), "repomind-l4-data-"));
    artifacts = mkdtempSync(join(tmpdir(), "repomind-l4-artifacts-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
    initializeRepository(otherRepository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(otherRepository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("builds an evidence-backed candidate after three successful sessions and requires fresh approval after changes", () => {
    const core = new RepositoryMemoryCore(repository);
    finish(core, "Release v0.12.0", "release-12");
    finish(core, "Release v0.13.0", "release-13");
    expect(core.rebuildSkillCandidates()).toEqual({ created: 0, updated: 0, unchanged: 0, candidates: [] });
    finish(core, "Release v0.14.0", "release-14");

    const rebuilt = core.rebuildSkillCandidates();
    expect(rebuilt).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const candidate = rebuilt.candidates[0]!;
    expect(candidate).toMatchObject({
      id: expect.stringMatching(/^l4_/),
      title: "Workflow: Release",
      status: "pending",
      sourceSessionCount: 3,
      steps: ["node [REDACTED:absolute-path] [REDACTED:absolute-path]"],
      verification: ["npm test"],
    });
    expect(candidate.risks).toEqual(expect.arrayContaining([expect.stringContaining("npm publish --dry-run")]));
    expect(core.rebuildSkillCandidates()).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    const details = core.inspectSkillCandidate(candidate.id);
    expect(details.sources).toHaveLength(3);
    expect(details.sources.every((source) => source.evidenceIds.length >= 5)).toBe(true);
    expect(details.audit).toEqual([expect.objectContaining({ action: "generated", nextStatus: "pending" })]);
    const output = join(artifacts, "SKILL.md");
    expect(() => core.exportSkillCandidate(candidate.id, output)).toThrow(/must be approved/u);

    const approved = core.reviewSkillCandidate({
      candidateId: candidate.id,
      action: "approve",
      reason: "Reviewed commands with token=super-secret-value and confirmed dry-run safety.",
    });
    expect(approved).toMatchObject({ status: "approved", reviewReason: expect.stringContaining("[REDACTED:credential]") });
    const exported = core.exportSkillCandidate(candidate.id, output);
    expect(exported).toMatchObject({ candidateId: candidate.id, path: output, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(existsSync(output)).toBe(true);
    const content = readFileSync(output, "utf8");
    expect(content).toContain("name: release");
    expect(content).toContain("## Verification");
    expect(content).not.toContain("super-secret-value");
    expect(content).not.toContain("D:\\private\\repo");
    expect(content).not.toContain("/root/private");
    expect(() => core.exportSkillCandidate(candidate.id, output)).toThrow(/overwrite/u);

    finish(core, "Release v0.15.0", "release-15");
    expect(core.rebuildSkillCandidates()).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
      candidates: [expect.objectContaining({ id: candidate.id, status: "pending", sourceSessionCount: 4, reviewedAt: null })],
    });
    const project = JSON.parse(readFileSync(join(repository, ".repomind", "project.json"), "utf8")) as { projectId: string };
    const database = new DatabaseSync(join(data, "repositories", project.projectId, "repomind.db"));
    database.prepare(`
      UPDATE skill_candidate_audit_log SET created_at=1, id=CASE action
        WHEN 'generated' THEN 'aud_d'
        WHEN 'approved' THEN 'aud_c'
        WHEN 'exported' THEN 'aud_b'
        WHEN 'sources_changed' THEN 'aud_a'
      END WHERE candidate_id=?
    `).run(candidate.id);
    database.close();
    expect(core.inspectSkillCandidate(candidate.id).audit.map((entry) => entry.action)).toEqual([
      "generated", "approved", "exported", "sources_changed",
    ]);
    expect(core.status()).toMatchObject({
      skillCandidates: 1,
      capabilities: { layeredMemory: { l0: true, l1: true, l2: true, l3: true, l4: true } },
    });

    const isolated = new RepositoryMemoryCore(otherRepository);
    expect(isolated.listSkillCandidates()).toEqual([]);
    expect(() => isolated.inspectSkillCandidate(candidate.id)).toThrow(/not found/u);
    isolated.close();
    core.close();
  });

  it("excludes unsuccessful and command-free sessions from workflow evidence", () => {
    const core = new RepositoryMemoryCore(repository);
    finish(core, "Release partial", "partial", "partial");
    finish(core, "Release failed", "failed", "failed");
    const abandoned = core.startSession({ task: "Release abandoned" });
    core.abandonSession(abandoned.sessionId);
    const commandFree = core.startSession({ task: "Release without verification" });
    core.commitSession({
      sessionId: commandFree.sessionId,
      idempotencyKey: "command-free",
      status: "success",
      summary: "No reusable workflow was recorded.",
    });
    expect(core.rebuildSkillCandidates()).toMatchObject({ candidates: [] });
    expect(() => core.rebuildSkillCandidates({ minSessions: 2 })).toThrow(/from 3 to 20/u);
    core.close();
  });
});
