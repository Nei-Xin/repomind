import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, withScratch } from "./scratch.js";

export interface ScenarioResult {
  name: string;
  passed: boolean;
  metrics: Record<string, number>;
  details: string[];
}

export interface ScenarioReport {
  suite: "cross-session-scenarios";
  scenarios: ScenarioResult[];
  summary: {
    scenarios: number;
    passed: number;
    failed: number;
    crossSessionRecall: number;
    evidenceBindingRate: number;
    isolationViolations: number;
    staleWarnedRate: number;
    conflictSurfacedRate: number;
    idempotencyViolations: number;
  };
}

/**
 * A brand-new core instance is the in-process equivalent of a new agent
 * session: nothing carries over except the database.
 */
function crossSessionRecall(): ScenarioResult {
  return withScratch(1, ([repository], openCore) => {
    const first = openCore(repository!);
    const session = first.startSession({ task: "Fix the flaky storage test on Windows" });
    writeFileSync(join(repository!, "storage.txt"), "reset the database between test cases\n", "utf8");
    git(repository!, "add", "storage.txt");
    git(repository!, "commit", "-q", "-m", "reset database between cases");
    first.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "scenario-recall",
      status: "success",
      summary: "Fixed the flaky storage test by resetting the database between cases",
      tests: [{ command: "npm test -- storage", exitCode: 0, summary: "3 tests passed" }],
    });
    first.close();

    const second = openCore(repository!);
    const start = second.startSession({ task: "The storage test is flaky again on Windows" });
    const relevant = start.memories.find((memory) => `${memory.title} ${memory.content}`.toLowerCase().includes("storage"));
    const evidenceCount = relevant ? (second.inspect(relevant.id).evidence as unknown[]).length : 0;
    second.close();
    return {
      name: "cross-session-recall",
      passed: relevant !== undefined && evidenceCount > 0,
      metrics: { recalledMemories: start.memories.length, relevantRecalled: relevant ? 1 : 0, evidenceOnRecalled: evidenceCount },
      details: relevant ? [`Recalled "${relevant.title}" with ${evidenceCount} evidence records`] : ["No relevant memory recalled at session start"],
    };
  });
}

function evidenceBinding(): ScenarioResult {
  return withScratch(1, ([repository], openCore) => {
    const core = openCore(repository!);
    for (let index = 0; index < 2; index++) {
      const session = core.startSession({ task: `Task ${index}: improve module ${index}` });
      core.commitSession({
        sessionId: session.sessionId,
        idempotencyKey: `scenario-binding-${index}`,
        status: "success",
        summary: `Improved module ${index} error handling`,
        decisions: [`Module ${index} wraps external calls in a typed adapter`],
        tests: [{ command: `npm test -- module-${index}`, exitCode: 0, summary: "passed" }],
      });
    }
    core.record({ type: "convention", title: "Manual fact", content: "Manual facts are also evidence-backed." });
    const db = core.context.database.raw;
    const total = Number((db.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count);
    const orphans = Number((db.prepare(
      "SELECT count(*) AS count FROM memories m WHERE NOT EXISTS (SELECT 1 FROM memory_evidence me WHERE me.memory_id = m.id)",
    ).get() as { count: number }).count);
    core.close();
    return {
      name: "evidence-binding",
      passed: total > 0 && orphans === 0,
      metrics: { memories: total, orphans, bindingRate: total ? (total - orphans) / total : 0 },
      details: [`${total} memories, ${orphans} without evidence`],
    };
  });
}

function repositoryIsolation(): ScenarioResult {
  return withScratch(2, ([repositoryA, repositoryB], openCore) => {
    const coreA = openCore(repositoryA!);
    const alpha = coreA.record({ type: "architecture", title: "Alpha gateway design", content: "The alpha gateway routes through the mesh proxy." });
    coreA.close();
    const coreB = openCore(repositoryB!);
    coreB.record({ type: "convention", title: "Beta storage rule", content: "Beta services persist to the beta store." });
    const leakedInB = coreB.search("alpha gateway mesh proxy").filter((memory) => memory.id === alpha.id).length;
    const coreA2 = openCore(repositoryA!);
    const leakedInA = coreA2.search("beta storage rule").filter((memory) => memory.title === "Beta storage rule").length;
    coreA2.close();
    coreB.close();
    return {
      name: "repository-isolation",
      passed: leakedInA === 0 && leakedInB === 0,
      metrics: { isolationViolations: leakedInA + leakedInB },
      details: [`Cross-repository leaks: ${leakedInA + leakedInB}`],
    };
  });
}

function staleWarning(): ScenarioResult {
  return withScratch(1, ([repository], openCore) => {
    writeFileSync(join(repository!, "config.txt"), "timeout=30\n", "utf8");
    const core = openCore(repository!);
    const recorded = core.record({
      type: "dependency",
      title: "Config timeout",
      content: "The service timeout is configured in config.txt.",
      relatedFiles: ["config.txt"],
    });
    writeFileSync(join(repository!, "config.txt"), "timeout=60\n", "utf8");
    const result = core.search("service timeout config").find((memory) => memory.id === recorded.id);
    core.close();
    const warned = result?.status === "uncertain" && typeof result.warning === "string";
    return {
      name: "stale-warning",
      passed: warned === true,
      metrics: { staleMemories: 1, warned: warned ? 1 : 0 },
      details: warned ? [`Warning: ${result!.warning}`] : ["Stale memory returned without a warning"],
    };
  });
}

function conflictSurfacing(): ScenarioResult {
  return withScratch(1, ([repository], openCore) => {
    const core = openCore(repository!);
    core.record({ type: "decision", title: "Cache strategy", content: "Cache aggressively at the edge." });
    core.record({ type: "decision", title: "Cache strategy", content: "Never cache at the edge; always hit origin." });
    const results = core.search("cache strategy edge");
    core.close();
    const surfaced = results.filter((memory) => memory.status === "uncertain" && memory.warning?.includes("conflicts with memory"));
    return {
      name: "conflict-surfacing",
      passed: results.length === 2 && surfaced.length === 2,
      metrics: { conflictingMemories: results.length, surfacedWithWarning: surfaced.length },
      details: [`${surfaced.length} of ${results.length} conflicting memories carried an explicit conflict warning`],
    };
  });
}

function idempotentCommit(): ScenarioResult {
  return withScratch(1, ([repository], openCore) => {
    const core = openCore(repository!);
    const session = core.startSession({ task: "Ship the retry helper" });
    const input = {
      sessionId: session.sessionId,
      idempotencyKey: "scenario-idempotent",
      status: "success" as const,
      summary: "Shipped the retry helper with exponential backoff",
      decisions: ["Retries use exponential backoff with jitter"],
    };
    const firstResult = core.commitSession(input);
    const db = core.context.database.raw;
    const countAfterFirst = Number((db.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count);
    const secondResult = core.commitSession(input);
    const countAfterSecond = Number((db.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count);
    core.close();
    const identical = JSON.stringify(firstResult) === JSON.stringify(secondResult);
    const duplicates = countAfterSecond - countAfterFirst;
    return {
      name: "idempotent-commit",
      passed: identical && duplicates === 0,
      metrics: { duplicateMemories: duplicates, identicalReceipt: identical ? 1 : 0 },
      details: [`Repeated commit created ${duplicates} duplicate memories; receipts identical: ${identical}`],
    };
  });
}

export function runScenarioSuite(): ScenarioReport {
  const runners = [crossSessionRecall, evidenceBinding, repositoryIsolation, staleWarning, conflictSurfacing, idempotentCommit];
  const scenarios = runners.map((runner) => {
    try {
      return runner();
    } catch (error) {
      return {
        name: runner.name,
        passed: false,
        metrics: {},
        details: [`Scenario threw: ${error instanceof Error ? error.message : String(error)}`],
      } satisfies ScenarioResult;
    }
  });
  const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
  return {
    suite: "cross-session-scenarios",
    scenarios,
    summary: {
      scenarios: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.passed).length,
      failed: scenarios.filter((scenario) => !scenario.passed).length,
      crossSessionRecall: byName.get("cross-session-recall")?.metrics.relevantRecalled ?? 0,
      evidenceBindingRate: byName.get("evidence-binding")?.metrics.bindingRate ?? 0,
      isolationViolations: byName.get("repository-isolation")?.metrics.isolationViolations ?? 1,
      staleWarnedRate: byName.get("stale-warning")?.metrics.warned ?? 0,
      conflictSurfacedRate: (byName.get("conflict-surfacing")?.metrics.surfacedWithWarning ?? 0) / 2,
      idempotencyViolations: byName.get("idempotent-commit")?.metrics.duplicateMemories ?? 1,
    },
  };
}
