import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
});
