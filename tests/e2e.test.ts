import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepository } from "./helpers.js";
import { git } from "./helpers.js";
import { runOpenCodeHost } from "../src/integrations/opencode/run.js";

const CLI = resolve("dist/cli/index.js");

function cli(repository: string, data: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args, "--repo", repository, "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      REPOMIND_DATA_DIR: data,
      REPOMIND_EMBEDDING_PROVIDER: "deterministic",
      REPOMIND_EMBEDDING_DIMENSIONS: "64",
    },
  }).trim();
}

describe("cross-process CLI end-to-end", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-e2e-data-"));
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("persists memories across separate CLI processes", { timeout: 30_000 }, () => {
    expect(existsSync(CLI), "dist/cli/index.js is missing; run npm run build before npm test").toBe(true);

    const initialized = JSON.parse(cli(repository, data, "init")) as { projectId: string };
    expect(initialized.projectId).toBeTruthy();

    const started = JSON.parse(cli(repository, data, "start", "--task", "Fix the flaky storage test")) as { sessionId: string; retrievalStrategy: string };
    expect(started.sessionId).toMatch(/^ses_/);
    expect(started.retrievalStrategy).toBe("hybrid-fts5-vector");

    const committed = JSON.parse(cli(
      repository, data, "commit",
      "--session", started.sessionId,
      "--key", "e2e-1",
      "--summary", "Stabilized the storage test by resetting the database between cases",
    )) as { status: string; memories: { stored: number } };
    expect(committed.status).toBe("committed");
    expect(committed.memories.stored).toBeGreaterThan(0);

    // Every later call is a brand-new process; only the database persists.
    const found = JSON.parse(cli(repository, data, "search", "flaky storage test")) as Array<{ id: string; type: string }>;
    expect(found.length).toBeGreaterThan(0);
    const solution = found.find((memory) => memory.type === "solution");
    expect(solution).toBeDefined();

    const status = JSON.parse(cli(repository, data, "status")) as { embeddings: number; capabilities: { vector: boolean } };
    expect(status).toMatchObject({ embeddings: expect.any(Number), capabilities: { vector: true } });
    expect(status.embeddings).toBeGreaterThan(0);

    const inspected = JSON.parse(cli(repository, data, "inspect", solution!.id)) as { evidence: unknown[]; audit: unknown[] };
    expect(inspected.evidence.length).toBeGreaterThan(0);
    expect(inspected.audit.length).toBeGreaterThan(0);
  });

  it("reviews and applies bootstrap candidates across CLI processes", () => {
    writeFileSync(join(repository, "README.md"), "# Payment router\n\nRoutes use idempotency keys before dispatching payment requests.\n", "utf8");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "document payment routing");
    JSON.parse(cli(repository, data, "init"));
    const candidatesPath = join(data, "bootstrap.json");
    const generated = JSON.parse(cli(repository, data, "bootstrap", "--output", candidatesPath)) as { candidates: number; bundle: { candidates: Array<{ id: string; source: { kind: string } }> } };
    expect(generated.candidates).toBeGreaterThanOrEqual(2);
    expect(generated.bundle.candidates.some((entry) => entry.source.kind === "readme")).toBe(true);
    expect(JSON.parse(cli(repository, data, "search", "idempotency dispatch"))).toEqual([]);

    const readme = generated.bundle.candidates.find((entry) => entry.source.kind === "readme")!;
    const applied = JSON.parse(cli(repository, data, "bootstrap-apply", "--input", candidatesPath, "--candidate", readme.id, "--yes")) as { stored: number; selected: number };
    expect(applied).toMatchObject({ stored: 1, selected: 1 });
    expect(JSON.parse(cli(repository, data, "search", "idempotency dispatch"))).toEqual([
      expect.objectContaining({ title: "Payment router", tags: expect.arrayContaining(["bootstrap", "readme"]) }),
    ]);
  });

  it("lists and inspects persisted host runs across CLI processes", async () => {
    JSON.parse(cli(repository, data, "init"));
    const report = await runOpenCodeHost({
      repository,
      task: "Inspect a daily host run",
      dataDirectory: data,
      outputDirectory: join(data, "run-output"),
      model: "test/model",
      execute: async () => ({
        exitCode: 0,
        signal: null,
        stdout: `${[
          { type: "text", part: { text: "Inspected the daily host run." } },
          { type: "step_finish", part: { reason: "stop" } },
        ].map(JSON.stringify).join("\n")}\n`,
        stderr: "",
        durationMs: 5,
        timedOut: false,
        aborted: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    });
    expect(report).toMatchObject({
      session: { status: "committed" },
      quality: { completion: "clean", status: "success" },
    });
    const runs = JSON.parse(cli(repository, data, "runs", "--status", "committed", "--limit", "5")) as Array<{ id: string }>;
    expect(runs).toEqual([expect.objectContaining({ id: report.runId })]);
    const inspected = JSON.parse(cli(repository, data, "run-inspect", report.runId)) as { id: string; model: string; reportPath: string };
    expect(inspected).toMatchObject({ id: report.runId, model: "test/model", reportPath: report.artifacts.report });
  });

  it("reviews and resolves uncertain memories across CLI processes", () => {
    JSON.parse(cli(repository, data, "init"));
    const first = JSON.parse(cli(
      repository, data, "record", "--type", "decision", "--title", "Queue backend", "--content", "Use SQLite.",
    )) as { id: string };
    const second = JSON.parse(cli(
      repository, data, "record", "--type", "decision", "--title", "Queue backend", "--content", "Use PostgreSQL.",
    )) as { id: string };

    const pending = JSON.parse(cli(repository, data, "review", "--kind", "conflict")) as {
      pending: number;
      returned: number;
      counts: { conflict: number };
      items: Array<{ id: string; suggestedCommands: { inspect: string } }>;
    };
    expect(pending).toMatchObject({ pending: 2, returned: 2, counts: { conflict: 2 } });
    expect(pending.items).toContainEqual(expect.objectContaining({
      id: first.id,
      suggestedCommands: expect.objectContaining({ inspect: `repomind inspect ${first.id}` }),
    }));

    const decisions = join(data, "review-decisions.json");
    writeFileSync(decisions, JSON.stringify({ actions: [{
      memoryId: second.id,
      action: "invalidate",
      reason: "The repository uses SQLite.",
    }] }), "utf8");
    expect(JSON.parse(cli(repository, data, "review-apply", "--input", decisions))).toMatchObject({ applied: 1, remaining: 0 });
    expect(JSON.parse(cli(repository, data, "review"))).toMatchObject({ pending: 0, returned: 0, items: [] });
    expect(JSON.parse(cli(repository, data, "review-history"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId: second.id, action: "memory_invalidated" }),
    ]));
  });

  it("rebuilds and recalls an L2 module narrative across CLI processes", () => {
    JSON.parse(cli(repository, data, "init"));
    const memory = JSON.parse(cli(
      repository, data, "record",
      "--type", "architecture",
      "--title", "Storage boundary",
      "--content", "The storage module owns SQLite transactions.",
      "--scope-type", "module",
      "--scope-value", "src/storage",
    )) as { id: string };
    const rebuilt = JSON.parse(cli(
      repository, data, "module-rebuild", "--module", "src/storage", "--budget", "900",
    )) as { created: number; narratives: Array<{ id: string }> };
    expect(rebuilt.created).toBe(1);
    const narrativeId = rebuilt.narratives[0]!.id;
    expect(JSON.parse(cli(repository, data, "modules"))).toEqual([
      expect.objectContaining({ id: narrativeId, modulePath: "src/storage", current: true }),
    ]);
    expect(JSON.parse(cli(repository, data, "module-inspect", narrativeId))).toMatchObject({
      id: narrativeId,
      sources: [{ memoryId: memory.id, evidenceIds: [expect.stringMatching(/^evd_/)] }],
    });
    expect(JSON.parse(cli(repository, data, "start", "--task", "Change the storage transaction boundary"))).toMatchObject({
      moduleNarratives: [expect.objectContaining({ id: narrativeId })],
    });
  });

  it("rebuilds and optionally injects an L3 repository profile across CLI processes", () => {
    JSON.parse(cli(repository, data, "init"));
    JSON.parse(cli(
      repository, data, "record",
      "--type", "architecture",
      "--title", "Repository boundary",
      "--content", "The repository uses local-first SQLite storage.",
    ));
    const rebuilt = JSON.parse(cli(
      repository, data, "profile-rebuild", "--budget", "1200", "--min-confidence", "0.8",
    )) as { profile: { id: string } };
    expect(JSON.parse(cli(repository, data, "profile"))).toMatchObject({ id: rebuilt.profile.id, current: true, version: 1 });
    expect(JSON.parse(cli(repository, data, "profile-inspect"))).toMatchObject({
      id: rebuilt.profile.id,
      memorySources: [{ evidenceIds: [expect.stringMatching(/^evd_/)] }],
      versions: [{ version: 1 }],
    });
    expect(JSON.parse(cli(repository, data, "start", "--task", "Review repository architecture"))).toMatchObject({
      repositoryProfile: { id: rebuilt.profile.id, current: true },
    });
    expect(JSON.parse(cli(repository, data, "start", "--task", "Review repository architecture", "--no-profile")))
      .not.toHaveProperty("repositoryProfile");
  });

  it("runs the complete L4 review and export workflow across CLI processes", { timeout: 30_000 }, () => {
    JSON.parse(cli(repository, data, "init"));
    for (let index = 1; index <= 3; index++) {
      const started = JSON.parse(cli(repository, data, "start", "--task", `Release v0.${index}.0`)) as { sessionId: string };
      const input = join(data, `release-${index}.json`);
      writeFileSync(input, JSON.stringify({
        sessionId: started.sessionId,
        idempotencyKey: `release-${index}`,
        status: "success",
        summary: `Release v0.${index}.0 completed after all checks.`,
        commands: [{ command: "npm run build", exitCode: 0, summary: "Build passed." }],
        tests: [{ command: "npm test", exitCode: 0, summary: "Tests passed." }],
      }), "utf8");
      expect(JSON.parse(cli(repository, data, "commit", "--input", input))).toMatchObject({ status: "committed" });
    }

    const rebuilt = JSON.parse(cli(repository, data, "skill-rebuild")) as { candidates: Array<{ id: string }> };
    const candidateId = rebuilt.candidates[0]!.id;
    expect(JSON.parse(cli(repository, data, "skills", "--status", "pending"))).toEqual([
      expect.objectContaining({ id: candidateId, sourceSessionCount: 3, status: "pending" }),
    ]);
    expect(JSON.parse(cli(repository, data, "skill-inspect", candidateId))).toMatchObject({
      sources: [expect.any(Object), expect.any(Object), expect.any(Object)],
      audit: [expect.objectContaining({ action: "generated" })],
    });
    expect(JSON.parse(cli(
      repository, data, "skill-review", candidateId, "--action", "approve", "--reason", "Commands reviewed.",
    ))).toMatchObject({ id: candidateId, status: "approved" });
    const output = join(data, "EXPORTED-SKILL.md");
    expect(JSON.parse(cli(repository, data, "skill-export", candidateId, "--output", output)))
      .toMatchObject({ candidateId, path: output });
    expect(existsSync(output)).toBe(true);
  });
});
