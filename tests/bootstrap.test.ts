import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBootstrapBundle,
  generateBootstrapBundle,
  loadBootstrapBundle,
  writeBootstrapBundle,
} from "../src/bootstrap.js";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository, git } from "./helpers.js";

function withDataDirectory<T>(dataDirectory: string, action: () => T): T {
  const previous = process.env.REPOMIND_DATA_DIR;
  process.env.REPOMIND_DATA_DIR = dataDirectory;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.REPOMIND_DATA_DIR;
    else process.env.REPOMIND_DATA_DIR = previous;
  }
}

function createBootstrapRepository(root: string): string {
  const repository = createTestRepository("repomind-bootstrap-repo-");
  writeFileSync(join(repository, "README.md"), "# Ledger service\n\nThe service records immutable ledger entries through src/ledger.js.\n", "utf8");
  writeFileSync(join(repository, "CONTRIBUTING.md"), "# Contribution rules\n\nRun npm test before every change and keep modules dependency-free.\n", "utf8");
  mkdirSync(join(repository, "docs", "adr"), { recursive: true });
  writeFileSync(join(repository, "docs", "adr", "ADR-001-ledger.md"), "# ADR-001 Immutable ledger\n\nLedger entries are append-only and must never be updated in place.\n", "utf8");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "document ledger architecture");
  withDataDirectory(join(root, "data"), () => initializeRepository(repository).database.close());
  return repository;
}

describe("bootstrap candidates", () => {
  let scratch: string | undefined;
  let repository: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (repository) rmSync(repository, { recursive: true, force: true });
    scratch = undefined;
    repository = undefined;
  });

  it("generates reviewable candidates without storing them, then applies only confirmed ids", () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-bootstrap-test-"));
    repository = createBootstrapRepository(scratch);
    const dataDirectory = join(scratch, "data");
    const bundle = withDataDirectory(dataDirectory, () => generateBootstrapBundle(repository!));

    expect(bundle.candidates.map((entry) => entry.source.kind)).toEqual(["readme", "contributing", "adr", "git-history"]);
    expect(new Set(bundle.candidates.map((entry) => entry.id)).size).toBe(4);
    withDataDirectory(dataDirectory, () => {
      const core = new RepositoryMemoryCore(repository!);
      expect(core.status()).toMatchObject({ memories: 0 });
      core.close();
    });

    const selected = bundle.candidates.find((entry) => entry.source.kind === "adr")!;
    const applied = withDataDirectory(dataDirectory, () => applyBootstrapBundle(repository!, bundle, [selected.id]));
    expect(applied).toMatchObject({ candidates: 4, selected: 1, stored: 1, skipped: 0 });
    const duplicate = withDataDirectory(dataDirectory, () => applyBootstrapBundle(repository!, bundle, [selected.id]));
    expect(duplicate).toMatchObject({ selected: 1, stored: 0, skipped: 1 });
    withDataDirectory(dataDirectory, () => {
      const core = new RepositoryMemoryCore(repository!);
      expect(core.search("append-only updated in place")).toEqual([expect.objectContaining({ id: applied.memories[0]!.memoryId })]);
      core.close();
    });
  });

  it("round-trips bundles, redacts candidates, and rejects changed or cross-project sources", () => {
    scratch = mkdtempSync(join(tmpdir(), "repomind-bootstrap-guard-"));
    repository = createBootstrapRepository(scratch);
    const dataDirectory = join(scratch, "data");
    writeFileSync(join(repository, "README.md"), "# Ledger service\n\nUse api_key=supersecret1234 only in the local development environment.\n", "utf8");
    const bundle = withDataDirectory(dataDirectory, () => generateBootstrapBundle(repository!));
    expect(JSON.stringify(bundle)).not.toContain("supersecret1234");
    expect(JSON.stringify(bundle)).toContain("[REDACTED:credential]");

    const path = join(scratch, "candidates.json");
    expect(writeBootstrapBundle(bundle, path)).toBe(path);
    expect(loadBootstrapBundle(path)).toEqual(bundle);
    expect(() => writeBootstrapBundle(bundle, path)).toThrow();
    expect(() => applyBootstrapBundle(repository!, {
      ...bundle,
      candidates: [{ ...bundle.candidates[0]!, content: "Tampered candidate content." }, ...bundle.candidates.slice(1)],
    })).toThrow("deterministic ids do not match");

    const readme = bundle.candidates.find((entry) => entry.source.kind === "readme")!;
    writeFileSync(join(repository, "README.md"), `${readFileSync(join(repository, "README.md"), "utf8")}changed\n`, "utf8");
    expect(() => withDataDirectory(dataDirectory, () => applyBootstrapBundle(repository!, bundle, [readme.id]))).toThrow("source changed");

    const other = createTestRepository("repomind-bootstrap-other-");
    try {
      withDataDirectory(join(scratch, "other-data"), () => initializeRepository(other).database.close());
      expect(() => withDataDirectory(join(scratch, "other-data"), () => applyBootstrapBundle(other, bundle))).toThrow("different repository project id");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
