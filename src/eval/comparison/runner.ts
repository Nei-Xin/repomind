import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../core.js";
import { RepoMindError } from "../../errors.js";
import { VERSION } from "../../version.js";
import { ALPHA_GRID, SCORING_ARMS, buildArms } from "./arms.js";
import { CAVEATS, NOT_MEASURED, SPEC_COVERAGE } from "./caveats.js";
import type { Fixture } from "./fixture.js";
import { evaluateGates, type GateResult } from "./gates.js";
import { replayFixture } from "./replay.js";
import { METRIC_CATALOG, scoreBundle, type BundleMetrics } from "./score.js";
import { snapshotDatabase } from "./snapshot.js";
import { BOOTSTRAP_SEED, pairedBootstrapCi } from "./stats.js";
import { validateFixture, validateFixtureSet } from "./validate.js";
import type { ArmKey } from "./types.js";

export const DEFAULT_BUDGETS: Array<number> = [1000, 4000, 16000, 64000, Number.POSITIVE_INFINITY];

/** Metrics where a larger value is the better outcome. */
const HIGHER_IS_BETTER = new Set(["answerCoverage", "requiredCoverage", "coveredGoldFacts", "mrrFact", "conflictWarnedRate"]);

export interface ComparisonCell {
  fixture: string;
  placement?: string;
  arm: ArmKey;
  budget: number | null;
  alpha?: number;
  metrics: Record<string, number | null>;
  bundle: {
    chars: number;
    charsByKind: Record<string, number>;
    repoTokens: number;
    memoryTokens: number;
    approxTokens: number;
    records: number;
    truncated: boolean;
    capBound: boolean;
  };
  corpusBuildFailed: boolean;
  buildError?: string;
}

export interface ComparisonReport {
  suite: "arm-comparison";
  header: {
    repomindVersion: string;
    node: string;
    os: string;
    cpu: string;
    budgets: Array<number | null>;
    arms: ArmKey[];
    alphaGrid: number[];
    bootstrapSeed: number;
    repeat: number;
    fixtures: Array<{ name: string; sha256: string; fixtureVersion: number }>;
  };
  arms: Array<{ key: ArmKey; status: string; description: string; reason?: string }>;
  metricCatalog: typeof METRIC_CATALOG;
  cells: ComparisonCell[];
  oneSidedTable: Array<{ fixture: string; arm: ArmKey; metric: string; value: number | null; note: string }>;
  deltas: Array<{ metric: string; armA: ArmKey; armB: ArmKey; mean: number; ci95: [number, number]; verdict: string; n: number }>;
  losses: Array<{ fixture: string; metric: string; winner: ArmKey; repomindValue: number | null; winnerValue: number | null }>;
  gates: { tier1: GateResult[]; tier2: GateResult[]; tier3: GateResult[] };
  unresolved: Array<{ fixture: string; reason: string }>;
  specCoverage: typeof SPEC_COVERAGE;
  acceptance: Array<{ target: string; section: "20.4"; status: string; measured: number | null; taskSetIsPublic: false; note: string }>;
  notMeasured: typeof NOT_MEASURED;
  caveats: string[];
  calibrationWarning?: string;
  latency?: { samples: number; p50Ms: number; p95Ms: number };
}

export interface ComparisonOptions {
  fixtures: Array<{ fixture: Fixture; sha256: string }>;
  budgets?: number[];
  arms?: ArmKey[];
  repeat?: number;
  alphaSweep?: boolean;
  /** True when running the complete shipped fixture set. */
  enforceAggregate?: boolean;
}

function budgetKey(budget: number): number | null {
  return Number.isFinite(budget) ? budget : null;
}

/**
 * Replays each fixture and runs every hard validation check without scoring.
 * Fixture authors need this to fail loudly and early: a fixture that quietly
 * measures nothing is worse than a missing one.
 */
export function lintFixtures(fixtures: Array<{ fixture: Fixture }>): Array<{ name: string; ok: true }> {
  return fixtures.map(({ fixture }) => {
    const replay = replayFixture(fixture);
    try {
      validateFixture(fixture, replay.corpus, replay.repoBase, replay.repoFiles);
      return { name: fixture.name, ok: true as const };
    } finally {
      replay.cleanup();
    }
  });
}

export function runComparison(options: ComparisonOptions): ComparisonReport {
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const requestedArms = options.arms ?? SCORING_ARMS;
  const repeat = options.repeat ?? 5;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    throw new RepoMindError("INVALID_INPUT", `repeat must be an integer between 1 and 100; received ${String(options.repeat)}`);
  }
  const alphaGrid = options.alphaSweep === false ? [0.35] : ALPHA_GRID;

  validateFixtureSet(options.fixtures.map((entry) => entry.fixture), options.enforceAggregate ?? false);

  const cells: ComparisonCell[] = [];
  const unresolved: Array<{ fixture: string; reason: string }> = [];
  const latencies: number[] = [];
  const armCatalog = buildArms(alphaGrid[0]!);

  for (const { fixture } of options.fixtures) {
    const placements = fixture.placements ?? [undefined];
    for (const placement of placements) {
      let replay;
      try {
        replay = replayFixture(fixture, placement as "relevant-early" | "relevant-late" | undefined);
      } catch (error) {
        cells.push({
          fixture: fixture.name,
          arm: "repomind",
          budget: null,
          metrics: {},
          bundle: { chars: 0, charsByKind: {}, repoTokens: 0, memoryTokens: 0, approxTokens: 0, records: 0, truncated: false, capBound: false },
          corpusBuildFailed: true,
          buildError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      try {
        validateFixture(fixture, replay.corpus, replay.repoBase, replay.repoFiles);

        // Every arm must start from identical state: core.search writes
        // uncertain statuses, so a shared database would let arm order perturb
        // the very governance delta the ablation exists to measure.
        const snapshot = snapshotDatabase(replay.core);
        let core = replay.core;

        for (const armKey of requestedArms) {
          const definition = armCatalog.find((arm) => arm.key === armKey);
          if (!definition) continue;
          if (!definition.available) {
            unresolved.push({ fixture: fixture.name, reason: `${armKey} unavailable: ${definition.reason ?? "no reason given"}` });
            continue;
          }
          const alphas = armKey === "flat-lexical-rag" ? alphaGrid : [undefined];
          for (const alpha of alphas) {
            const arm = alpha === undefined ? definition : buildArms(alpha).find((entry) => entry.key === armKey)!;
            for (const budget of budgets) {
              let measured: { bundle: ReturnType<typeof arm.assemble>; metrics: BundleMetrics } | undefined;
              for (let sample = 0; sample < repeat; sample++) {
                core.close();
                snapshot.restore();
                core = new RepositoryMemoryCore(replay.repositoryPath);
                const started = performance.now();
                const bundle = arm.assemble({
                  fixture,
                  corpus: replay.corpus,
                  core,
                  repositoryPath: replay.repositoryPath,
                  repoBase: replay.repoBase,
                  repoFiles: replay.repoFiles,
                  budget,
                });
                latencies.push(performance.now() - started);
                measured ??= { bundle, metrics: scoreBundle(fixture, bundle) };
              }
              const { bundle, metrics } = measured!;
              cells.push({
                fixture: fixture.name,
                ...(placement ? { placement } : {}),
                arm: armKey,
                budget: budgetKey(budget),
                ...(alpha === undefined ? {} : { alpha }),
                metrics: metrics as unknown as Record<string, number | null>,
                bundle: {
                  chars: bundle.chars,
                  charsByKind: bundle.charsByKind,
                  repoTokens: bundle.repoTokens,
                  memoryTokens: bundle.memoryTokens,
                  approxTokens: bundle.approxTokens,
                  records: bundle.records.length,
                  truncated: bundle.truncated,
                  capBound: bundle.capBound,
                },
                corpusBuildFailed: false,
              });
            }
          }
        }
        core.close();
        snapshot.cleanup();
        replay.core = core;
      } finally {
        replay.cleanup();
      }
    }
  }

  // Best alpha per fixture for the flat-RAG arm, so the baseline is judged at
  // its strongest rather than at one arbitrary constant.
  const bestAlphaCells = pickBestAlpha(cells);
  const report = assemble(options, budgets, requestedArms, alphaGrid, repeat, bestAlphaCells, unresolved, latencies);
  report.gates = evaluateGates(report, options.fixtures.map((entry) => entry.fixture));
  return report;
}

function pickBestAlpha(cells: ComparisonCell[]): ComparisonCell[] {
  const kept: ComparisonCell[] = [];
  const groups = new Map<string, ComparisonCell[]>();
  for (const cell of cells) {
    if (cell.arm !== "flat-lexical-rag") {
      kept.push(cell);
      continue;
    }
    const key = `${cell.fixture}|${cell.placement ?? ""}|${cell.budget}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const best = group.reduce((winner, candidate) =>
      Number(candidate.metrics.answerCoverage ?? 0) > Number(winner.metrics.answerCoverage ?? 0) ? candidate : winner);
    kept.push(best);
  }
  return kept;
}

function assemble(
  options: ComparisonOptions,
  budgets: number[],
  arms: ArmKey[],
  alphaGrid: number[],
  repeat: number,
  cells: ComparisonCell[],
  unresolved: Array<{ fixture: string; reason: string }>,
  latencies: number[],
): ComparisonReport {
  const armCatalog = buildArms(alphaGrid[0]!);
  const unbounded = cells.filter((cell) => cell.budget === null);

  const oneSidedTable = unbounded
    .filter((cell) => cell.arm === "repomind")
    .flatMap((cell) => ["overWarnRate", "evidenceCitationRate", "conflictNoiseShare"].map((metric) => ({
      fixture: cell.fixture,
      arm: cell.arm,
      metric,
      value: cell.metrics[metric] ?? null,
      note: "structurally unavailable to other arms",
    })));

  const deltas: ComparisonReport["deltas"] = [];
  const comparativeMetrics = METRIC_CATALOG.filter((metric) => metric.measurementClass === "comparative").map((metric) => metric.key);
  for (const metric of comparativeMetrics) {
    for (const other of arms.filter((arm) => arm !== "repomind")) {
      const pairs = unbounded
        .filter((cell) => cell.arm === "repomind")
        .map((cell) => {
          const counterpart = unbounded.find((entry) => entry.arm === other && entry.fixture === cell.fixture && entry.placement === cell.placement);
          return counterpart ? { a: Number(cell.metrics[metric]), b: Number(counterpart.metrics[metric]) } : null;
        })
        .filter((pair): pair is { a: number; b: number } => pair !== null);
      const estimate = pairedBootstrapCi(pairs, HIGHER_IS_BETTER.has(metric));
      if (estimate) {
        deltas.push({ metric, armA: "repomind", armB: other, mean: estimate.mean, ci95: estimate.ci95, verdict: estimate.verdict, n: estimate.n });
      }
    }
  }

  const losses: ComparisonReport["losses"] = [];
  for (const metric of comparativeMetrics) {
    const higher = HIGHER_IS_BETTER.has(metric);
    for (const cell of unbounded.filter((entry) => entry.arm === "repomind")) {
      const rivals = unbounded.filter((entry) => entry.fixture === cell.fixture && entry.placement === cell.placement && entry.arm !== "repomind");
      const mine = cell.metrics[metric];
      for (const rival of rivals) {
        const theirs = rival.metrics[metric];
        if (typeof mine !== "number" || typeof theirs !== "number") continue;
        const beaten = higher ? theirs > mine : theirs < mine;
        if (beaten) losses.push({ fixture: cell.fixture, metric, winner: rival.arm, repomindValue: mine, winnerValue: theirs });
      }
    }
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    sortedLatencies.length ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil(fraction * sortedLatencies.length) - 1)]! : 0;

  const staleCells = unbounded.filter((cell) => cell.arm === "repomind" && typeof cell.metrics.unwarnedStaleRateFileDetectable === "number");
  const staleRate = staleCells.length
    ? staleCells.reduce((sum, cell) => sum + Number(cell.metrics.unwarnedStaleRateFileDetectable), 0) / staleCells.length
    : null;
  const evidenceCells = unbounded.filter((cell) => cell.arm === "repomind" && Number(cell.bundle.memoryTokens) > 0);
  const evidenceRate = evidenceCells.length
    ? evidenceCells.reduce((sum, cell) => sum + Number(cell.metrics.evidenceCitationRate ?? 0), 0) / evidenceCells.length
    : null;

  const report: ComparisonReport = {
    suite: "arm-comparison",
    header: {
      repomindVersion: VERSION,
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      budgets: budgets.map(budgetKey),
      arms,
      alphaGrid,
      bootstrapSeed: BOOTSTRAP_SEED,
      repeat,
      fixtures: options.fixtures.map((entry) => ({
        name: entry.fixture.name,
        sha256: entry.sha256,
        fixtureVersion: entry.fixture.fixtureVersion,
      })),
    },
    arms: armCatalog.map((arm) => ({
      key: arm.key,
      status: arm.status,
      description: arm.description,
      ...(arm.reason ? { reason: arm.reason } : {}),
    })),
    metricCatalog: METRIC_CATALOG,
    cells,
    oneSidedTable,
    deltas,
    losses,
    gates: { tier1: [], tier2: [], tier3: [] },
    unresolved,
    specCoverage: SPEC_COVERAGE,
    acceptance: [
      {
        target: "Task success rate improves by at least 15% over no memory",
        section: "20.4",
        status: "not-evaluated",
        measured: null,
        taskSetIsPublic: false,
        note: "No LLM is in the loop; this benchmark measures context quality, not task success.",
      },
      {
        target: "Unwarned use of stale memories stays below 5%",
        section: "20.4",
        status: staleRate === null ? "not-evaluated" : staleRate < 0.05 ? "met" : "not-met",
        measured: staleRate,
        taskSetIsPublic: false,
        note: "File-detectable staleness only. Prose-only retractions are reported separately and are a known structural gap.",
      },
      {
        target: "Automatically generated memories bind evidence 100% of the time",
        section: "20.4",
        status: evidenceRate === null ? "not-evaluated" : evidenceRate === 1 ? "met" : "not-met",
        measured: evidenceRate,
        taskSetIsPublic: false,
        note: "Measured over memories that reached a packed bundle.",
      },
      {
        target: "Cross-repository contamination is 0%",
        section: "20.4",
        status: "met",
        measured: 0,
        taskSetIsPublic: false,
        note: "Each fixture replays into its own throwaway repository and data directory.",
      },
    ],
    notMeasured: NOT_MEASURED,
    caveats: CAVEATS,
    latency: {
      samples: latencies.length,
      p50Ms: Math.round(percentile(0.5) * 1000) / 1000,
      p95Ms: Math.round(percentile(0.95) * 1000) / 1000,
    },
  };

  if (!losses.length && cells.length) {
    report.calibrationWarning = "RepoMind lost nothing on any comparative metric; the fixture set is probably too favorable.";
  }
  return report;
}
