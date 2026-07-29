import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import {
  backupManifestPath,
  backupRepository,
  exportRepository,
  importRepository,
  loadRepositoryExport,
  restoreRepository,
} from "../src/portability/repository-data.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

const PASSPHRASE = randomBytes(24).toString("base64");
const WRONG_PASSPHRASE = randomBytes(24).toString("base64");

interface MutableArchive extends Record<string, unknown> {
  ciphertext: string;
  createdAt: number;
  purpose: string;
  cipher: { tag: string };
}

function temporaryPlaintextDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("repomind-encrypted-backup-") || name.startsWith("repomind-encrypted-restore-"))
    .sort();
}

function mutateBase64(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

describe("encrypted repository portability", () => {
  let sourceRepository: string;
  let targetRepository: string;
  let data: string;
  let artifacts: string;

  beforeEach(() => {
    sourceRepository = createTestRepository("repomind-encrypted-source-");
    targetRepository = createTestRepository("repomind-encrypted-target-");
    data = mkdtempSync(join(tmpdir(), "repomind-encrypted-data-"));
    artifacts = mkdtempSync(join(tmpdir(), "repomind-encrypted-artifacts-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(sourceRepository).database.close();
    initializeRepository(targetRepository).database.close();
  });

  afterEach(() => {
    rmSync(sourceRepository, { recursive: true, force: true });
    rmSync(targetRepository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("round-trips an authenticated logical export without exposing plaintext", () => {
    const source = new RepositoryMemoryCore(sourceRepository);
    const memoryTitle = "Encrypted portability decision";
    const memory = source.record({
      type: "decision",
      title: memoryTitle,
      content: "Logical archives must authenticate metadata and ciphertext.",
    });
    const exportPath = join(artifacts, "repository-export.enc.json");
    const exported = exportRepository(source.context, exportPath, { passphrase: PASSPHRASE });
    source.close();

    expect(exported).toMatchObject({ encrypted: true, encryption: { purpose: "repository-export" } });
    const archiveText = readFileSync(exportPath, "utf8");
    expect(archiveText).not.toContain(memoryTitle);
    expect(() => loadRepositoryExport(exportPath)).toThrow(/passphrase/u);
    expect(loadRepositoryExport(exportPath, { passphrase: PASSPHRASE }).tables.memories).toHaveLength(1);

    const target = new RepositoryMemoryCore(targetRepository);
    const existing = target.record({ type: "risk", title: "Preserve on failure", content: "Failed decryption changes nothing." });
    expect(() => importRepository(target.context, exportPath, { passphrase: WRONG_PASSPHRASE })).toThrow(/authentication/u);
    expect(target.inspect(existing.id).title).toBe("Preserve on failure");

    const imported = importRepository(target.context, exportPath, { passphrase: PASSPHRASE });
    expect(imported).toMatchObject({ imported: true, encrypted: true, encryption: { purpose: "repository-export" } });
    expect(() => target.inspect(existing.id)).toThrow();
    expect(target.inspect(memory.id).title).toBe(memoryTitle);
    target.close();
  });

  it("rejects authenticated logical archive tampering and purpose mismatch before target writes", () => {
    const source = new RepositoryMemoryCore(sourceRepository);
    source.record({ type: "convention", title: "Authenticated archives", content: "Reject any modified envelope." });
    const exportPath = join(artifacts, "valid.enc.json");
    exportRepository(source.context, exportPath, { passphrase: PASSPHRASE });
    source.close();
    const original = JSON.parse(readFileSync(exportPath, "utf8")) as MutableArchive;

    const variants: Array<[string, (archive: MutableArchive) => void, RegExp]> = [
      ["ciphertext", (archive) => { archive.ciphertext = mutateBase64(archive.ciphertext); }, /authentication/u],
      ["tag", (archive) => { archive.cipher.tag = mutateBase64(archive.cipher.tag); }, /authentication/u],
      ["aad", (archive) => { archive.createdAt += 1; }, /authentication/u],
      ["purpose", (archive) => { archive.purpose = "sqlite-backup"; }, /purpose/u],
    ];

    const target = new RepositoryMemoryCore(targetRepository);
    const retained = target.record({ type: "risk", title: "Atomic failure", content: "This remains after every rejection." });
    for (const [name, mutate, error] of variants) {
      const archive = structuredClone(original);
      mutate(archive);
      const path = join(artifacts, `${name}.enc.json`);
      writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
      expect(() => importRepository(target.context, path, { passphrase: PASSPHRASE })).toThrow(error);
      expect(target.inspect(retained.id).title).toBe("Atomic failure");
    }
    expect(target.status()).toMatchObject({ memories: 1 });
    target.close();
  });

  it("round-trips an encrypted physical backup and removes temporary plaintext", () => {
    const beforeTemporary = temporaryPlaintextDirectories();
    const core = new RepositoryMemoryCore(sourceRepository);
    const retainedTitle = "Backup baseline";
    const retained = core.record({ type: "decision", title: retainedTitle, content: "This is retained by restore." });
    const backupPath = join(artifacts, "repository.db.enc");
    const backup = backupRepository(core.context, backupPath, { passphrase: PASSPHRASE });
    expect(backup).toMatchObject({ encrypted: true, manifestPath: null, encryption: { purpose: "sqlite-backup" } });
    expect(existsSync(backupManifestPath(backupPath))).toBe(false);
    expect(readFileSync(backupPath, "utf8")).not.toContain(retainedTitle);
    const removedTitle = "Post-backup write";
    const removed = core.record({ type: "risk", title: removedTitle, content: "Restore removes this memory." });
    core.close();

    expect(() => restoreRepository(sourceRepository, backupPath, { passphrase: WRONG_PASSPHRASE })).toThrow(/authentication/u);
    let reopened = new RepositoryMemoryCore(sourceRepository);
    expect(reopened.inspect(retained.id).title).toBe(retainedTitle);
    expect(reopened.inspect(removed.id).title).toBe(removedTitle);
    reopened.close();

    expect(restoreRepository(sourceRepository, backupPath, { passphrase: PASSPHRASE, dryRun: true }))
      .toMatchObject({ restored: false, encrypted: true, preRestoreBackup: null });
    const restored = restoreRepository(sourceRepository, backupPath, { passphrase: PASSPHRASE });
    expect(restored).toMatchObject({ restored: true, encrypted: true, inputPath: backupPath });
    expect(restored.preRestoreBackup && existsSync(restored.preRestoreBackup)).toBe(true);
    reopened = new RepositoryMemoryCore(sourceRepository);
    expect(reopened.inspect(retained.id).title).toBe(retainedTitle);
    expect(() => reopened.inspect(removed.id)).toThrow();
    reopened.close();
    expect(temporaryPlaintextDirectories()).toEqual(beforeTemporary);
  });

  it("rejects short passphrases and still requires sensitive-export approval", () => {
    const core = new RepositoryMemoryCore(sourceRepository);
    const shortPath = join(artifacts, "short.enc.json");
    expect(() => exportRepository(core.context, shortPath, { passphrase: "too-short" })).toThrow(/at least 12/u);
    expect(existsSync(shortPath)).toBe(false);

    const memory = core.record({ type: "decision", title: "Credential rotation", content: "Stored value is injected below." });
    core.context.database.raw.prepare("UPDATE memories SET content=? WHERE id=?")
      .run(`Accidental token sk-${"a".repeat(24)}`, memory.id);
    const blockedPath = join(artifacts, "blocked.enc.json");
    expect(() => exportRepository(core.context, blockedPath, { passphrase: PASSPHRASE })).toThrow(/sensitive/u);
    expect(existsSync(blockedPath)).toBe(false);
    expect(exportRepository(core.context, join(artifacts, "allowed.enc.json"), {
      allowSensitive: true,
      passphrase: PASSPHRASE,
    })).toMatchObject({ encrypted: true, sensitiveFindings: 1 });
    core.close();
  });
});
