import type { Fixture } from "./fixture.js";
import type { ComparisonReport } from "./runner.js";

export interface GateResult {
  tier: 1 | 2 | 3;
  id: string;
  passed: boolean;
  detail: string;
  waived?: boolean;
  waiverReason?: string;
}

const HIGHER_IS_BETTER = new Set(["answerCoverage", "requiredCoverage", "coveredGoldFacts", "mrrFact", "conflictWarnedRate"]);

/**
 * Tier 1 is absolute correctness, tier 2 is the spec's deterministic targets,
 * and tier 3 is the anti-self-serving core: it fails when the fixture set stops
 * stressing RepoMind, which is the failure mode a benchmark written by the
 * project's own authors is most likely to drift into.
 */
export function evaluateGates(report: ComparisonReport, fixtures: Fixture[]): ComparisonReport["gates"] {
  const unbounded = report.cells.filter((cell) => cell.budget === null);
  const repomind = unbounded.filter((cell) => cell.arm === "repomind");

  const tier1: GateResult[] = [];
  const buildFailures = report.cells.filter((cell) => cell.corpusBuildFailed);
  tier1.push({
    tier: 1,
    id: "corpus-build",
    passed: buildFailures.length === 0,
    detail: buildFailures.length
      ? `${buildFailures.length} fixtures failed to build: ${buildFailures.map((cell) => `${cell.fixture} (${cell.buildError})`).join("; ")}`
      : "every fixture replayed through the public API",
  });

  const leaks = repomind.filter((cell) => Number(cell.metrics.supersededLeakRate ?? 0) > 0);
  tier1.push({
    tier: 1,
    id: "superseded-leak",
    passed: leaks.length === 0,
    detail: leaks.length ? `retired memories reached the bundle in: ${leaks.map((cell) => cell.fixture).join(", ")}` : "no retired memory reached any bundle",
  });

  const withMemories = repomind.filter((cell) => cell.bundle.memoryTokens > 0);
  const unbound = withMemories.filter((cell) => Number(cell.metrics.evidenceCitationRate ?? 0) < 1);
  tier1.push({
    tier: 1,
    id: "evidence-binding",
    passed: unbound.length === 0,
    detail: unbound.length ? `memories without evidence in: ${unbound.map((cell) => cell.fixture).join(", ")}` : "every packed memory cites evidence",
  });

  const tier2: GateResult[] = [];
  const staleCells = repomind.filter((cell) => typeof cell.metrics.unwarnedStaleRateFileDetectable === "number");
  const staleRate = staleCells.length
    ? staleCells.reduce((sum, cell) => sum + Number(cell.metrics.unwarnedStaleRateFileDetectable), 0) / staleCells.length
    : null;
  tier2.push({
    tier: 2,
    id: "unwarned-stale-file-detectable",
    passed: staleRate === null || staleRate < 0.05,
    detail: staleRate === null ? "no file-detectable stale fact reached a bundle" : `rate ${staleRate.toFixed(3)} against a 0.05 ceiling`,
  });

  const proseCells = repomind.filter((cell) => typeof cell.metrics.unwarnedStaleRateProseOnly === "number");
  const proseRate = proseCells.length
    ? proseCells.reduce((sum, cell) => sum + Number(cell.metrics.unwarnedStaleRateProseOnly), 0) / proseCells.length
    : null;
  tier2.push({
    tier: 2,
    id: "unwarned-stale-prose-only",
    passed: true,
    detail: proseRate === null
      ? "no prose-only stale fact reached a bundle"
      : `rate ${proseRate.toFixed(3)}; reported, not gated: file-hash staleness detection is structurally blind to retractions stated only in prose`,
  });

  const tier3: GateResult[] = [];
  for (const fixture of fixtures) {
    for (const loss of fixture.designedLoss ?? []) {
      const gateId = `designedLoss:${fixture.name}:${loss.arm}:${loss.metric}`;
      const waiver = (fixture.waivers ?? []).find((entry) => entry.gate === gateId || entry.gate === `designedLoss:${fixture.name}:${loss.metric}`);
      const mine = repomind.find((cell) => cell.fixture === fixture.name)?.metrics[loss.metric];
      const theirs = unbounded.find((cell) => cell.fixture === fixture.name && cell.arm === loss.arm)?.metrics[loss.metric];
      if (typeof mine !== "number" || typeof theirs !== "number") {
        tier3.push({ tier: 3, id: gateId, passed: false, detail: `metric ${loss.metric} missing for ${fixture.name}` });
        continue;
      }
      const higher = HIGHER_IS_BETTER.has(loss.metric);
      const wins = higher ? theirs > mine : theirs < mine;
      const ties = theirs === mine;
      const satisfied = loss.mode === "tie-or-win" ? wins || ties : wins;
      tier3.push({
        tier: 3,
        id: gateId,
        passed: satisfied || Boolean(waiver),
        detail: satisfied
          ? `${loss.arm} ${loss.metric}=${theirs} vs repomind ${mine}, as designed`
          : `designedLoss ${fixture.name} metric ${loss.metric} was won by repomind (${mine} vs ${theirs}); the fixture is not stressing what it claims`,
        ...(waiver ? { waived: true, waiverReason: waiver.reason } : {}),
      });
    }
    for (const cost of fixture.designedCost ?? []) {
      const value = repomind.find((cell) => cell.fixture === fixture.name)?.metrics[cost.metric];
      tier3.push({
        tier: 3,
        id: `designedCost:${fixture.name}:${cost.metric}`,
        passed: typeof value === "number" && value >= cost.min,
        detail: typeof value === "number"
          ? `${cost.metric}=${value} against a declared floor of ${cost.min}`
          : `${cost.metric} not measured for ${fixture.name}`,
      });
    }
  }

  tier3.push({
    tier: 3,
    id: "honesty-sections-present",
    passed: report.caveats.length > 0 && report.notMeasured.length > 0,
    detail: `${report.caveats.length} caveats, ${report.notMeasured.length} not-measured entries`,
  });
  tier3.push({
    tier: 3,
    id: "repomind-loses-somewhere",
    passed: report.losses.length > 0,
    detail: report.losses.length
      ? `${report.losses.length} comparative losses recorded`
      : "RepoMind lost nothing; the fixture set is probably too favorable",
  });
  const adversarialShare = fixtures.length ? fixtures.filter((fixture) => fixture.adversarial).length / fixtures.length : 0;
  tier3.push({
    tier: 3,
    id: "adversarial-share",
    passed: adversarialShare >= 0.375,
    detail: `${adversarialShare.toFixed(3)} against a 0.375 floor`,
  });

  return { tier1, tier2, tier3 };
}
