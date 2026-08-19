import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(first.profile.sourceMemoryIds).toEqual(expect.arrayContaining([
      moduleMemory.id, dependency.id, command.id,
    ]));
    expect(first.profile.sourceModuleNarrativeIds).toEqual([moduleNarrative.id]);
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

  it("does not upgrade L2 or L3 when sources only gain Evidence or validation", () => {
    const core = new RepositoryMemoryCore(repository);
    const moduleInput = {
      type: "architecture" as const,
      title: "Storage ownership",
      content: "The storage module owns durable repository state.",
      confidence: 0.95,
      scopeType: "module" as const,
      scopeValue: "src/storage",
    };
    const repositoryInput = {
      type: "dependency" as const,
      title: "Supported runtime",
      content: "Use Node.js 22 or newer.",
      confidence: 0.95,
    };
    const moduleMemory = core.record(moduleInput);
    const repositoryMemory = core.record(repositoryInput);
    const firstL2 = core.rebuildModuleNarratives();
    const firstL3 = core.rebuildRepositoryProfile();

    expect(firstL2.narratives[0]).toMatchObject({ version: 1, current: true });
    expect(firstL3.profile).toMatchObject({ version: 1, current: true });
    expect(core.record(moduleInput)).toMatchObject({ id: moduleMemory.id, stored: false });
    expect(core.record(repositoryInput)).toMatchObject({ id: repositoryMemory.id, stored: false });
    core.validateMemory({ memoryId: moduleMemory.id, reason: "Confirmed the storage boundary again." });
    core.validateMemory({ memoryId: repositoryMemory.id, reason: "Confirmed the supported runtime again." });
    expect(core.inspect(moduleMemory.id).evidence).toHaveLength(3);
    expect(core.inspect(repositoryMemory.id).evidence).toHaveLength(3);

    expect(core.listModuleNarratives()[0]).toMatchObject({ version: 1, current: true });
    expect(core.getRepositoryProfile()).toMatchObject({ version: 1, current: true });
    expect(core.rebuildModuleNarratives()).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      narratives: [expect.objectContaining({ version: 1, current: true })],
    });
    expect(core.rebuildRepositoryProfile()).toMatchObject({
      created: false,
      updated: false,
      unchanged: true,
      profile: { version: 1, current: true },
    });
    expect(core.inspectRepositoryProfile().versions).toHaveLength(1);
    core.close();
  });

  it("merges prior stale-file facts with new facts, deduplicates replacements, and removes invalid sources", () => {
    const moduleDirectory = join(repository, "src", "storage");
    const moduleFile = join(moduleDirectory, "index.ts");
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(moduleFile, "export const storageMode = 'local';\n");

    const core = new RepositoryMemoryCore(repository);
    const command = core.record({
      type: "command",
      title: "Storage verification",
      content: "Run npm test for storage changes.",
      confidence: 0.95,
      relatedFiles: ["src/storage/index.ts"],
    });
    const architecture = core.record({
      type: "architecture",
      title: "Storage ownership",
      content: "The storage module owns local persistence.",
      confidence: 0.95,
      scopeType: "module",
      scopeValue: "src/storage",
      relatedFiles: ["src/storage/index.ts"],
    });
    core.rebuildModuleNarratives();
    const first = core.rebuildRepositoryProfile().profile;
    expect(first).toMatchObject({ version: 1, memorySourceCount: 1, moduleSourceCount: 1 });

    writeFileSync(moduleFile, [
      "export const storageMode = 'local';",
      "export const transactionMode = 'atomic';",
      "",
    ].join("\n"));
    expect(core.search("storage persistence")[0]).toMatchObject({ id: architecture.id, status: "uncertain" });
    expect(core.getRepositoryProfile()).toMatchObject({ version: 1, current: false });
    const dependency = core.record({
      type: "dependency",
      title: "SQLite runtime",
      content: "Storage requires SQLite support in the Node.js runtime.",
      confidence: 0.95,
    });
    const requirement = core.record({
      type: "requirement",
      title: "Atomic storage writes",
      content: "Storage writes must remain atomic.",
      confidence: 0.95,
      scopeType: "module",
      scopeValue: "src/storage",
      relatedFiles: ["src/storage/index.ts"],
    });
    core.rebuildModuleNarratives();
    const merged = core.rebuildRepositoryProfile().profile;
    expect(merged).toMatchObject({ version: 2, memorySourceCount: 2, moduleSourceCount: 1 });
    expect(merged.sourceMemoryIds).toEqual(expect.arrayContaining([
      command.id, architecture.id, dependency.id, requirement.id,
    ]));
    expect(merged.content).toContain("Storage verification");
    expect(merged.content).toContain("Storage ownership");
    expect(merged.content).toContain("SQLite runtime");
    expect(merged.content).toContain("Atomic storage writes");
    expect(merged.content).toContain("[stale: verify against current files]");

    const replacement = core.record({
      type: "command",
      title: "Current storage verification",
      content: "Run npm  test for storage changes.",
      confidence: 0.95,
      relatedFiles: ["src/storage/index.ts"],
    });
    const deduplicated = core.rebuildRepositoryProfile().profile;
    expect(deduplicated).toMatchObject({ version: 3, memorySourceCount: 2, moduleSourceCount: 1 });
    expect(deduplicated.sourceMemoryIds).toContain(replacement.id);
    expect(deduplicated.sourceMemoryIds).not.toContain(command.id);
    expect(deduplicated.content.match(/npm\s+test for storage changes\./gu)).toHaveLength(1);

    core.invalidateMemory({ memoryId: replacement.id, reason: "Use a different storage verification command." });
    core.invalidateMemory({ memoryId: architecture.id, reason: "The storage module no longer owns persistence." });
    core.rebuildModuleNarratives();
    const withoutInvalid = core.rebuildRepositoryProfile().profile;
    expect(withoutInvalid).toMatchObject({ version: 4, memorySourceCount: 1, moduleSourceCount: 1 });
    expect(withoutInvalid.sourceMemoryIds).toEqual(expect.arrayContaining([dependency.id, requirement.id]));
    expect(withoutInvalid.sourceMemoryIds).not.toContain(command.id);
    expect(withoutInvalid.sourceMemoryIds).not.toContain(replacement.id);
    expect(withoutInvalid.sourceMemoryIds).not.toContain(architecture.id);
    expect(withoutInvalid.content).not.toContain("Storage verification");
    expect(withoutInvalid.content).not.toContain("Storage ownership");
    expect(withoutInvalid.content).toContain("SQLite runtime");
    expect(withoutInvalid.content).toContain("Atomic storage writes");
    core.close();
  });
});
