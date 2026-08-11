import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import type {
  RebuildModuleNarrativesInput,
  RebuildModuleNarrativesResult,
  RebuildRepositoryProfileInput,
  RebuildRepositoryProfileResult,
  RebuildSkillCandidatesInput,
  RebuildSkillCandidatesResult,
} from "../src/domain/types.js";
import { RepoMindError } from "../src/errors.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

function commitSuccessfulSession(core: RepositoryMemoryCore, key: string): string {
  const started = core.startSession({ task: `Run the release workflow ${key}` });
  const committed = core.commitSession({
    sessionId: started.sessionId,
    idempotencyKey: key,
    status: "success",
    summary: "The release workflow completed successfully.",
    commands: [{ command: "npm run build", exitCode: 0, summary: "Build completed." }],
    tests: [{ command: "npm test", exitCode: 0, summary: "All tests passed." }],
  });
  expect(committed.status).toBe("committed");
  return started.sessionId;
}

class L2FailureCore extends RepositoryMemoryCore {
  override rebuildModuleNarratives(_input: RebuildModuleNarrativesInput = {}): RebuildModuleNarrativesResult {
    throw new RepoMindError("STORAGE_UNAVAILABLE", "Injected L2 maintenance failure");
  }
}

class AllStagesFailureCore extends RepositoryMemoryCore {
  override rebuildModuleNarratives(_input: RebuildModuleNarrativesInput = {}): RebuildModuleNarrativesResult {
    throw new RepoMindError("STORAGE_UNAVAILABLE", "Injected L2 maintenance failure");
  }

  override rebuildRepositoryProfile(_input: RebuildRepositoryProfileInput = {}): RebuildRepositoryProfileResult {
    throw new Error("Injected L3 maintenance failure");
  }

  override rebuildSkillCandidates(_input: RebuildSkillCandidatesInput = {}): RebuildSkillCandidatesResult {
    throw new RepoMindError("STORAGE_UNAVAILABLE", "Injected L4 maintenance failure");
  }
}

describe("derived layer maintenance", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository("repomind-derived-maintenance-");
    data = mkdtempSync(join(tmpdir(), "repomind-derived-maintenance-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("maintains L2, L3, and a pending L4 candidate idempotently", () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({
      type: "architecture",
      title: "Storage ownership",
      content: "The storage module owns persistent repository data.",
      confidence: 0.95,
      scopeType: "module",
      scopeValue: "src/storage",
    });
    commitSuccessfulSession(core, "release-1");
    commitSuccessfulSession(core, "release-2");
    commitSuccessfulSession(core, "release-3");

    const first = core.maintainDerivedLayers();
    expect(first).toMatchObject({
      status: "success",
      l2: { status: "success", result: { created: 1 } },
      l3: { status: "success", result: { created: true } },
      l4: {
        status: "success",
        result: {
          created: 1,
          candidates: [expect.objectContaining({ status: "pending", sourceSessionCount: 3 })],
        },
      },
    });
    const candidate = first.l4.result!.candidates[0]!;
    const profileVersion = first.l3.result!.profile.version;

    const second = core.maintainDerivedLayers();
    expect(second).toMatchObject({
      status: "success",
      l2: { status: "success", result: { unchanged: 1 } },
      l3: { status: "success", result: { unchanged: true, profile: { version: profileVersion } } },
      l4: { status: "success", result: { unchanged: 1, candidates: [expect.objectContaining({ id: candidate.id })] } },
    });

    core.reviewSkillCandidate({ candidateId: candidate.id, action: "approve", reason: "Reviewed commands and risks." });
    commitSuccessfulSession(core, "release-4");
    const refreshed = core.maintainDerivedLayers();
    expect(refreshed.l4).toMatchObject({
      status: "success",
      result: {
        updated: 1,
        candidates: [expect.objectContaining({ id: candidate.id, status: "pending", sourceSessionCount: 4, reviewedAt: null })],
      },
    });
    core.close();
  });

  it("skips every stage when no derived source is available", () => {
    const core = new RepositoryMemoryCore(repository);
    const result = core.maintainDerivedLayers();
    expect(result).toMatchObject({
      status: "skipped",
      l2: { status: "skipped", result: { created: 0, updated: 0, unchanged: 0, deleted: 0 }, error: null },
      l3: { status: "skipped", result: null, error: null },
      l4: { status: "skipped", result: { created: 0, updated: 0, unchanged: 0 }, error: null },
    });
    core.close();
  });

  it("captures an L2 failure and continues with L3 and L4 without changing the committed session", () => {
    const core = new L2FailureCore(repository);
    core.record({
      type: "architecture",
      title: "Repository architecture",
      content: "The repository keeps a stable local architecture profile.",
      confidence: 0.95,
    });
    const sessionId = commitSuccessfulSession(core, "partial-maintenance");

    let result: ReturnType<RepositoryMemoryCore["maintainDerivedLayers"]> | undefined;
    expect(() => { result = core.maintainDerivedLayers(); }).not.toThrow();
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      status: "partial",
      l2: { status: "failed", result: null, error: { code: "STORAGE_UNAVAILABLE" } },
      l3: { status: "success" },
      l4: { status: "skipped" },
    });
    expect(core.listSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sessionId, status: "committed" }),
    ]));
    core.close();
  });

  it("captures failures from every stage and returns failed instead of throwing", () => {
    const core = new AllStagesFailureCore(repository);
    const sessionId = commitSuccessfulSession(core, "failed-maintenance");
    const result = core.maintainDerivedLayers();
    expect(result).toMatchObject({
      status: "failed",
      l2: { status: "failed", error: { code: "STORAGE_UNAVAILABLE" } },
      l3: { status: "failed", error: { code: "INTERNAL_ERROR", message: "Injected L3 maintenance failure" } },
      l4: { status: "failed", error: { code: "STORAGE_UNAVAILABLE" } },
    });
    expect(core.listSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sessionId, status: "committed" }),
    ]));
    core.close();
  });
});
