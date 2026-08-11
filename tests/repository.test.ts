import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databasePath } from "../src/config/paths.js";
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

  it("places a valid UUID database under the configured data directory", () => {
    const projectId = randomUUID();
    const path = databasePath(projectId);

    expect(path).toBe(resolve(realpathSync.native(data), "repositories", projectId, "repomind.db"));
    expect(existsSync(dirname(path))).toBe(true);
  });

  it("rejects traversal, path separators, absolute paths, and malformed project ids before creating directories", () => {
    const escapedDirectory = resolve(data, "outside-project");
    const invalidProjectIds = [
      "../outside-project",
      `${randomUUID()}/nested`,
      `${randomUUID()}\\nested`,
      resolve(data, "..", "absolute-project"),
      "not-a-uuid",
    ];

    for (const projectId of invalidProjectIds) {
      expect(() => databasePath(projectId)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
    expect(existsSync(escapedDirectory)).toBe(false);
  });

  it("rejects an invalid project id read from a repository marker without escaping the data root", () => {
    const marker = join(repository, ".repomind", "project.json");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1, projectId: "../escaped", name: "unsafe" }), "utf8");

    expect(() => initializeRepository(repository)).toThrowError(expect.objectContaining({ code: "REPOSITORY_NOT_INITIALIZED" }));
    expect(existsSync(resolve(data, "escaped"))).toBe(false);
  });

  it.each(["repositories root", "project directory"])("rejects a database path through a linked %s", (location) => {
    const projectId = randomUUID();
    const outside = join(repository, `outside-${location.replaceAll(" ", "-")}`);
    mkdirSync(outside);
    const repositories = join(data, "repositories");
    if (location === "repositories root") {
      symlinkSync(outside, repositories, process.platform === "win32" ? "junction" : "dir");
    } else {
      mkdirSync(repositories);
      symlinkSync(outside, join(repositories, projectId), process.platform === "win32" ? "junction" : "dir");
    }

    expect(() => databasePath(projectId)).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_REPOSITORY" }));
    expect(existsSync(join(outside, "repomind.db"))).toBe(false);
  });

  it("rejects dangling SQLite links before they can create an outside target", () => {
    const projectId = randomUUID();
    const projectDirectory = join(data, "repositories", projectId);
    const outside = join(repository, process.platform === "win32" ? "outside-database-directory" : "outside-database.db");
    mkdirSync(projectDirectory, { recursive: true });
    symlinkSync(outside, join(projectDirectory, "repomind.db"), process.platform === "win32" ? "junction" : "file");

    expect(() => databasePath(projectId)).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_REPOSITORY" }));
    expect(existsSync(outside)).toBe(false);
  });
});
