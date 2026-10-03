import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveActivityStore } from "../src/activity/store.js";
import * as gitInspector from "../src/git/git-inspector.js";
import { initializeRepository } from "../src/repository.js";
import { createTestRepository } from "./helpers.js";

describe("interactive task concurrency", () => {
  let repository: string, data: string, first: InteractiveActivityStore, second: InteractiveActivityStore;
  const common = () => ({ schemaVersion: 1, agent: "opencode", agentSessionId: "concurrent", repositoryPath: repository } as const);
  const start = (eventId: string) => ({ ...common(), eventId, task: `Task ${eventId}`, maxMemories: 0 });
  const state = () => first.core.context.database.raw.prepare("SELECT current_session_id FROM agent_sessions").get() as { current_session_id: string | null };
  const sessions = () => first.core.context.database.raw.prepare("SELECT id,status FROM sessions ORDER BY started_at,id").all() as Array<{ id: string; status: string }>;
  beforeEach(() => {
    repository = createTestRepository(); data = mkdtempSync(join(tmpdir(), "repomind-concurrency-"));
    vi.stubEnv("REPOMIND_DATA_DIR", data);
    initializeRepository(repository).database.close();
    first = new InteractiveActivityStore(repository, data); second = new InteractiveActivityStore(repository, data);
    first.core.context.database.raw.exec("CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)");
  });
  afterEach(() => {
    vi.restoreAllMocks(); first.close(); second.close(); vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  });

  it.each([false, true])("allows a separate process to write during every Git collection (replacement=%s)", replacement => {
    if (replacement) {
      first.startTask(start("old"));
      writeFileSync(join(repository, "README.txt"), "changed before replacement\n");
    }
    let probes = 0;
    for (const name of ["inspectGit", "inspectWorktreeFiles", "filesChangedBetweenHeads", "captureDiff"] as const) {
      const original = gitInspector[name];
      vi.spyOn(gitInspector, name).mockImplementation(((...args: never[]) => {
        // Independent OS process, real SQLite write. A short timeout makes the
        // old BEGIN IMMEDIATE wrapper fail deterministically without a 5s wait.
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1]);
          db.exec('PRAGMA busy_timeout=100');
          db.prepare('INSERT INTO lock_probe DEFAULT VALUES').run(); db.close();
        `, first.core.context.database.path], { encoding: "utf8", timeout: 5000 });
        expect(result.status, `${name}: ${result.stderr}`).toBe(0);
        probes++;
        return (original as (...args: never[]) => unknown)(...args);
      }) as never);
    }
    const current = first.startTask(start("new"));
    expect(probes).toBeGreaterThanOrEqual(replacement ? 6 : 2);
    expect(state().current_session_id).toBe(current.sessionId);
    expect(sessions().map(row => row.status).sort()).toEqual(replacement ? ["open", "partial"] : ["open"]);
  });

  function interleave(action: () => void) {
    const prepare = first.core.prepareSessionStart.bind(first.core);
    return vi.spyOn(first.core, "prepareSessionStart").mockImplementationOnce(input => {
      const writer = prepare(input);
      action();
      return writer;
    });
  }

  it.each([false, true])("deduplicates concurrent identical start events (replacement=%s)", replacement => {
    if (replacement) first.startTask(start("old"));
    let winningId: string;
    interleave(() => { winningId = second.startTask(start("same")).sessionId; });
    const result = first.startTask(start("same"));
    expect(result).toMatchObject({ sessionId: winningId!, resumed: true });
    expect(sessions().filter(row => row.status === "open")).toEqual([{ id: winningId!, status: "open" }]);
    expect(sessions()).toHaveLength(replacement ? 2 : 1);
    expect(first.core.context.database.raw.prepare("SELECT id FROM activity_events WHERE event_type='user_message'").all()).toHaveLength(replacement ? 2 : 1);
  });

  it.each(["task", "maxMemories", "agentSessionId"] as const)("rejects a concurrent replay with a different %s", field => {
    interleave(() => { second.startTask(start("same")); });
    const input = { ...start("same"), [field]: field === "maxMemories" ? 3 : "different" };
    expect(() => first.startTask(input)).toThrow(/reused with different input/);
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]!.status).toBe("open");
  });

  it("recollects snapshots after a competing start without mixing the old tasks' evidence", () => {
    const old = first.startTask(start("old"));
    writeFileSync(join(repository, "README.txt"), "old task change\n");
    let competingId: string;
    const prepare = interleave(() => {
      competingId = second.startTask(start("competing")).sessionId;
      writeFileSync(join(repository, "README.txt"), "competing task change\n");
    });
    const next = first.startTask(start("next"));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(sessions().filter(row => row.status === "open")).toEqual([{ id: next.sessionId, status: "open" }]);
    expect(state().current_session_id).toBe(next.sessionId);
    const diff = (id: string) => (first.core.context.database.raw.prepare("SELECT content FROM evidence WHERE session_id=? AND kind='git_diff'").get(id) as { content: string }).content;
    expect(diff(old.sessionId)).toContain("+old task change");
    expect(diff(old.sessionId)).not.toContain("competing task change");
    expect(diff(competingId!)).toContain("+competing task change");
    const baseline = first.core.context.database.raw.prepare("SELECT content FROM evidence WHERE session_id=? AND kind='git_snapshot'").get(next.sessionId);
    expect(baseline).toBeDefined();
    expect(first.core.context.database.raw.prepare("SELECT session_id FROM commit_receipts ORDER BY session_id").all())
      .toEqual([old.sessionId, competingId!].sort().map(session_id => ({ session_id })));
  });

  it.each(["finish", "abort", "commit"] as const)("preserves a concurrent %s instead of superseding it", action => {
    const old = first.startTask(start("old"));
    interleave(() => {
      if (action === "finish") second.finish({ ...common(), eventId: "done", summary: "Completed old task." });
      else if (action === "abort") second.abort({ ...common(), eventId: "aborted", reason: "User cancelled" });
      else second.core.commitSession({ sessionId: old.sessionId, idempotencyKey: "direct", status: "success", summary: "Committed old task." });
    });
    const next = first.startTask(start("next"));
    expect(sessions()).toContainEqual({ id: old.sessionId, status: action === "abort" ? "abandoned" : "committed" });
    expect(state().current_session_id).toBe(next.sessionId);
    expect(first.core.context.database.raw.prepare("SELECT id FROM evidence WHERE session_id=? AND content LIKE '%superseded by a new%'").all(old.sessionId)).toEqual([]);
  });

  it("bounds retries without orphaning a session when the task keeps changing", () => {
    const prepare = first.core.prepareSessionStart.bind(first.core);
    let count = 0;
    vi.spyOn(first.core, "prepareSessionStart").mockImplementation(input => {
      const writer = prepare(input);
      second.startTask(start(`competitor-${++count}`));
      return writer;
    });
    expect(() => first.startTask(start("loser"))).toThrow(/changed repeatedly/);
    expect(count).toBe(3);
    expect(sessions()).toHaveLength(3);
    expect(sessions().filter(row => row.status === "open")).toHaveLength(1);
    expect(first.core.context.database.raw.prepare("SELECT id FROM activity_events WHERE id='activity:loser'").get()).toBeUndefined();
  });

  it("retries when the old task closes before commit preparation can read it", () => {
    const old = first.startTask(start("old"));
    const prepare = first.core.prepareSessionCommit.bind(first.core);
    vi.spyOn(first.core, "prepareSessionCommit").mockImplementationOnce((...args) => {
      second.finish({ ...common(), eventId: "done", summary: "Completed old task." });
      return prepare(...args);
    });
    const next = first.startTask(start("next"));
    expect(state().current_session_id).toBe(next.sessionId);
    expect(sessions()).toContainEqual({ id: old.sessionId, status: "committed" });
    expect(sessions()).toHaveLength(2);
  });

  it.each(["git", "activity", "retrieval"] as const)("rolls back the whole replacement if %s fails", failure => {
    const old = first.startTask(start("old"));
    if (failure === "git") vi.spyOn(gitInspector, "captureDiff").mockImplementationOnce(() => { throw new Error("injected failure"); });
    if (failure === "activity") first.core.context.database.raw.exec("CREATE TRIGGER reject_start BEFORE INSERT ON activity_events WHEN NEW.id='activity:next' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    if (failure === "retrieval") vi.spyOn(first.core, "searchModuleNarratives").mockImplementationOnce(() => { throw new Error("injected failure"); });
    expect(() => first.startTask(start("next"))).toThrow("injected failure");
    expect(sessions()).toEqual([{ id: old.sessionId, status: "open" }]);
    expect(state().current_session_id).toBe(old.sessionId);
    expect(first.core.context.database.raw.prepare("SELECT * FROM commit_receipts").all()).toEqual([]);
    expect(first.core.context.database.raw.prepare("SELECT id FROM evidence WHERE kind='agent_summary'").all()).toEqual([]);
  });

  it("replays without Git and rejects replay of a directly closed task", () => {
    const old = first.startTask(start("old"));
    const inspect = vi.spyOn(gitInspector, "inspectGit").mockImplementation(() => { throw new Error("unexpected Git"); });
    expect(first.startTask(start("old"))).toMatchObject({ sessionId: old.sessionId, resumed: true });
    second.core.abandonSession(old.sessionId);
    expect(() => first.startTask(start("old"))).toThrow(/completed or superseded/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("a finishing task cannot clear a newer task started during maintenance", () => {
    const old = first.startTask(start("old"));
    let nextId: string;
    const maintain = first.core.maintainMemoryLayers.bind(first.core);
    vi.spyOn(first.core, "maintainMemoryLayers").mockImplementationOnce(() => {
      nextId = second.startTask(start("next")).sessionId;
      return maintain();
    });
    first.finish({ ...common(), eventId: "done", summary: "Completed old task." });
    expect(state().current_session_id).toBe(nextId!);
    expect(sessions()).toContainEqual({ id: old.sessionId, status: "committed" });
    expect(sessions()).toContainEqual({ id: nextId!, status: "open" });
  });
});
