import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("repository initialization", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("keeps a stable project identity across repeated initialization", () => {
    const first = initializeRepository(repository);
    const firstId = first.marker.projectId;
    first.database.close();
    const second = initializeRepository(repository);
    expect(second.marker.projectId).toBe(firstId);
    expect(second.database.raw.prepare("SELECT count(*) AS count FROM repository_checkouts").get()).toMatchObject({ count: 1 });
    second.database.close();
  });
});
