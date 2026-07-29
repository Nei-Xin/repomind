import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("L3 repository profile", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-l3-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("builds a versioned bounded profile and ignores low-confidence changes across L1 and L2", () => {
    const core = new RepositoryMemoryCore(repository);
    const moduleMemory = core.record({
      type: "architecture",
      title: "Storage boundary",
      content: "The storage module owns SQLite transactions and migrations.",
      confidence: 0.95,
      scopeType: "module",
      scopeValue: "src/storage",
    });
    const moduleNarrative = core.rebuildModuleNarratives().narratives[0]!;
    const dependency = core.record({
      type: "dependency", title: "Node runtime", content: "Use Node.js 22 or newer.", confidence: 0.95,
    });
    const command = core.record({
      type: "command", title: "Verification command", content: "Run npm test and npm run typecheck.", confidence: 0.95,
    });
    core.record({
      type: "decision", title: "Local-first storage", content: "Repository memory remains local by default.", confidence: 0.9,
    });

    const first = core.rebuildRepositoryProfile({ maxChars: 1400, minConfidence: 0.8 });
    expect(first).toMatchObject({ created: true, updated: false, unchanged: false });
    expect(first.profile).toMatchObject({
      memorySourceCount: 3, moduleSourceCount: 1, budgetChars: 1400, minConfidence: 0.8, version: 1, current: true,
    });
    expect(first.profile.content.length).toBeLessThanOrEqual(1400);
    expect(first.profile.content).toContain(moduleNarrative.id);
    expect(first.profile.content).toContain(dependency.id);
    expect(first.profile.content).toContain(command.id);

    const inspected = core.inspectRepositoryProfile();
    expect(inspected.memorySources.every((source) => source.evidenceIds.length > 0)).toBe(true);
    expect(inspected.moduleSources).toEqual([
      expect.objectContaining({ narrativeId: moduleNarrative.id, memoryIds: [moduleMemory.id] }),
    ]);
    expect(inspected.versions).toHaveLength(1);
    expect(inspected.versions[0]?.memoryIds).toEqual(expect.arrayContaining([moduleMemory.id, dependency.id, command.id]));
    expect(core.rebuildRepositoryProfile({ maxChars: 1400, minConfidence: 0.8 })).toMatchObject({ unchanged: true });

    const highConfidenceModule = core.record({
      type: "requirement", title: "Storage transaction requirement",
      content: "Storage writes must remain transactional.", confidence: 0.95,
      scopeType: "module", scopeValue: "src/storage",
    });
    expect(core.getRepositoryProfile()).toMatchObject({ current: false, version: 1 });
    core.rebuildModuleNarratives({ modules: ["src/storage"] });
    const moduleUpdated = core.rebuildRepositoryProfile({ maxChars: 1400, minConfidence: 0.8 });
    expect(moduleUpdated).toMatchObject({ updated: true, profile: { version: 2, current: true } });
    expect(core.inspectRepositoryProfile().versions[1]?.memoryIds).toContain(highConfidenceModule.id);

    core.record({
      type: "risk", title: "Speculative repository risk", content: "One task guessed this risk.", confidence: 0.4,
    });
    core.record({
      type: "risk", title: "Speculative module risk", content: "One task guessed a module risk.", confidence: 0.4,
      scopeType: "module", scopeValue: "src/storage",
    });
    core.rebuildModuleNarratives({ modules: ["src/storage"] });
    expect(core.getRepositoryProfile()).toMatchObject({ current: true, version: 2 });
    expect(core.rebuildRepositoryProfile({ maxChars: 1400, minConfidence: 0.8 })).toMatchObject({ unchanged: true });

    core.record({
      type: "requirement", title: "Release requirement", content: "Every release passes cross-process tests.", confidence: 0.95,
    });
    expect(core.getRepositoryProfile()).toMatchObject({ current: false, version: 2 });
    const staleSession = core.startSession({ task: "Prepare a release" });
    expect(staleSession.repositoryProfile).toBeUndefined();
    core.abandonSession(staleSession.sessionId);

    const updated = core.rebuildRepositoryProfile({ maxChars: 1400, minConfidence: 0.8 });
    expect(updated).toMatchObject({ created: false, updated: true, unchanged: false, profile: { version: 3, current: true } });
    expect(core.inspectRepositoryProfile().versions).toHaveLength(3);
    const started = core.startSession({ task: "Prepare a release" });
    expect(started.repositoryProfile).toMatchObject({ id: first.profile.id, version: 3, current: true });
    core.abandonSession(started.sessionId);
    const optedOut = core.startSession({ task: "Prepare a release", includeRepositoryProfile: false });
    expect(optedOut.repositoryProfile).toBeUndefined();
    core.abandonSession(optedOut.sessionId);
    expect(core.status()).toMatchObject({
      repositoryProfiles: 1,
      capabilities: { layeredMemory: { l0: true, l1: true, l2: true, l3: true, l4: true } },
    });
    core.close();
  });

  it("rejects profile generation without a stable source", () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({ type: "solution", title: "Low confidence task", content: "A one-off task result.", confidence: 0.4 });
    expect(() => core.rebuildRepositoryProfile()).toThrow(/No stable L1 or current L2 sources/u);
    core.close();
  });
});
