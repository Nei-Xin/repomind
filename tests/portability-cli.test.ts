import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository } from "./helpers.js";

const CLI = resolve("dist/cli/index.js");

function cli(repository: string, data: string, ...args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args, "--repo", repository, "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, REPOMIND_DATA_DIR: data },
  }).trim());
}

function cliProcess(repository: string, data: string, environment: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args, "--repo", repository, "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, REPOMIND_DATA_DIR: data, ...environment },
  });
}

describe("portability CLI", () => {
  let source: string;
  let target: string;
  let data: string;
  let artifacts: string;

  beforeEach(() => {
    source = createTestRepository("repomind-portability-cli-source-");
    target = createTestRepository("repomind-portability-cli-target-");
    data = mkdtempSync(join(tmpdir(), "repomind-portability-cli-data-"));
    artifacts = mkdtempSync(join(tmpdir(), "repomind-portability-cli-artifacts-"));
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("round-trips logical data and restores a physical snapshot across processes", () => {
    expect(existsSync(CLI), "dist/cli/index.js is missing; run npm run build before npm test").toBe(true);
    cli(source, data, "init");
    cli(target, data, "init");
    const original = cli(source, data, "record", "--type", "decision", "--title", "Portable decision", "--content", "Use checksummed archives.") as { id: string };
    const exportPath = join(artifacts, "repository.json");
    const backupPath = join(artifacts, "repository.db");
    expect(cli(source, data, "export", "--output", exportPath)).toMatchObject({ path: exportPath });
    expect(cli(source, data, "backup", "--output", backupPath)).toMatchObject({ path: backupPath });

    cli(target, data, "record", "--type", "risk", "--title", "Replaced target", "--content", "This is removed by import.");
    expect(cli(target, data, "import", "--input", exportPath, "--dry-run")).toMatchObject({ imported: false });
    expect(cli(target, data, "import", "--input", exportPath, "--yes")).toMatchObject({ imported: true });
    const imported = cli(target, data, "search", "checksummed archives") as Array<{ id: string }>;
    expect(imported.map((item) => item.id)).toContain(original.id);

    cli(source, data, "record", "--type", "risk", "--title", "Post-backup fact", "--content", "This is removed by restore.");
    expect(cli(source, data, "restore", "--input", backupPath, "--dry-run")).toMatchObject({ restored: false });
    const restored = cli(source, data, "restore", "--input", backupPath, "--yes") as { restored: boolean; preRestoreBackup: string };
    expect(restored.restored).toBe(true);
    expect(existsSync(restored.preRestoreBackup)).toBe(true);
    expect(cli(source, data, "status")).toMatchObject({ memories: 1 });
  }, 30_000);

  it("round-trips encrypted archives using environment-only passphrases without leaking them", () => {
    expect(existsSync(CLI), "dist/cli/index.js is missing; run npm run build before npm test").toBe(true);
    cli(source, data, "init");
    cli(target, data, "init");
    const original = cli(source, data, "record", "--type", "decision", "--title", "Encrypted CLI decision", "--content", "Keep archive secrets out of argv.") as { id: string };
    const exportPath = join(artifacts, "repository.enc.json");
    const backupPath = join(artifacts, "repository.db.enc");
    const variable = "REPOMIND_TEST_ARCHIVE_PASSPHRASE";
    const wrongVariable = "REPOMIND_TEST_ARCHIVE_WRONG_PASSPHRASE";
    const passphrase = randomBytes(24).toString("base64");
    const wrongPassphrase = randomBytes(24).toString("base64");
    const environment = { [variable]: passphrase, REPOMIND_ARCHIVE_PASSPHRASE: passphrase };

    const encryptedExport = cliProcess(source, data, environment, "export", "--output", exportPath, "--encrypt", "--passphrase-env", variable);
    expect(encryptedExport.status).toBe(0);
    expect(JSON.parse(encryptedExport.stdout)).toMatchObject({ path: exportPath, encrypted: true });
    expect(`${encryptedExport.stdout}${encryptedExport.stderr}`).not.toContain(passphrase);
    expect(readFileSync(exportPath, "utf8")).not.toContain("Encrypted CLI decision");

    const encryptedBackup = cliProcess(source, data, environment, "backup", "--output", backupPath, "--encrypt");
    expect(encryptedBackup.status).toBe(0);
    expect(JSON.parse(encryptedBackup.stdout)).toMatchObject({ path: backupPath, encrypted: true, manifestPath: null });
    expect(`${encryptedBackup.stdout}${encryptedBackup.stderr}`).not.toContain(passphrase);

    const imported = cliProcess(target, data, environment, "import", "--input", exportPath, "--passphrase-env", variable, "--yes");
    expect(imported.status).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ imported: true, encrypted: true });
    expect(`${imported.stdout}${imported.stderr}`).not.toContain(passphrase);
    expect((cli(target, data, "search", "archive secrets") as Array<{ id: string }>).map((item) => item.id)).toContain(original.id);

    cli(source, data, "record", "--type", "risk", "--title", "Post-backup CLI write", "--content", "A successful restore removes this.");
    const rejected = cliProcess(source, data, { [wrongVariable]: wrongPassphrase }, "restore", "--input", backupPath, "--passphrase-env", wrongVariable, "--yes");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/authentication/u);
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(passphrase);
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(wrongPassphrase);
    expect(cli(source, data, "status")).toMatchObject({ memories: 2 });

    const restored = cliProcess(source, data, environment, "restore", "--input", backupPath, "--yes");
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ restored: true, encrypted: true });
    expect(`${restored.stdout}${restored.stderr}`).not.toContain(passphrase);
    expect(cli(source, data, "status")).toMatchObject({ memories: 1 });

    const missingPath = join(artifacts, "missing-secret.enc.json");
    const missingVariable = "REPOMIND_TEST_ARCHIVE_MISSING_PASSPHRASE_018";
    const missing = cliProcess(source, data, {}, "export", "--output", missingPath, "--encrypt", "--passphrase-env", missingVariable);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(missingVariable);
    expect(existsSync(missingPath)).toBe(false);
  }, 60_000);
});
