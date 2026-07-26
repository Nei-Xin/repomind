import type { ComparisonReport } from "./runner.js";

function table(rows: string[][]): string {
  if (!rows.length) return "_none_";
  const header = rows[0]!;
  const body = rows.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function format(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (!Number.isFinite(value)) return "∞";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * Losses, unmeasured metrics, and caveats print before any RepoMind result, so
 * the failure cases cannot be skimmed past on the way to the headline.
 */
export function renderMarkdown(report: ComparisonReport): string {
  const sections: string[] = [];
  sections.push("# RepoMind comparison benchmark");
  sections.push(
    `RepoMind ${report.header.repomindVersion} · Node ${report.header.node} · ${report.header.os} · ${report.header.cpu}\n` +
    `${report.header.fixtures.length} fixtures · budgets ${report.header.budgets.map((budget) => budget ?? "unbounded").join(", ")}`,
  );

  sections.push("## Where RepoMind loses");
  sections.push(table([
    ["fixture", "metric", "winner", "repomind", "winner value"],
    ...report.losses.map((loss) => [loss.fixture, loss.metric, loss.winner, format(loss.repomindValue), format(loss.winnerValue)]),
  ]));

  sections.push("## Not measured");
  sections.push(table([
    ["metric", "spec", "why"],
    ...report.notMeasured.map((entry) => [entry.key, entry.specRef, entry.reason]),
  ]));

  if (report.unresolved.length) {
    sections.push("## Unresolved comparisons");
    sections.push(table([["fixture", "reason"], ...report.unresolved.map((entry) => [entry.fixture, entry.reason])]));
  }

  sections.push("## Conclusions this benchmark does not support");
  sections.push(report.caveats.map((caveat) => `> ${caveat}`).join("\n>\n"));

  sections.push("## Comparative results at unbounded budget");
  const unbounded = report.cells.filter((cell) => cell.budget === null && !cell.corpusBuildFailed);
  const armKeys = [...new Set(unbounded.map((cell) => cell.arm))];
  const fixtures = [...new Set(unbounded.map((cell) => cell.fixture))];
  sections.push(table([
    ["fixture", ...armKeys.map((arm) => `${arm} coverage`)],
    ...fixtures.map((fixture) => [
      fixture,
      ...armKeys.map((arm) => format(unbounded.find((cell) => cell.fixture === fixture && cell.arm === arm)?.metrics.answerCoverage ?? null)),
    ]),
  ]));

  sections.push("### Tokens to full required coverage");
  sections.push(table([
    ["fixture", ...armKeys.map((arm) => arm)],
    ...fixtures.map((fixture) => [
      fixture,
      ...armKeys.map((arm) => format(unbounded.find((cell) => cell.fixture === fixture && cell.arm === arm)?.metrics.tokensToCoverage ?? null)),
    ]),
  ]));

  sections.push("## Deltas with 95% bootstrap intervals");
  sections.push(table([
    ["metric", "vs", "mean", "ci95", "verdict"],
    ...report.deltas.map((delta) => [
      delta.metric, delta.armB, format(delta.mean),
      `[${format(delta.ci95[0])}, ${format(delta.ci95[1])}]`, delta.verdict,
    ]),
  ]));

  sections.push("## Structurally unavailable to other arms");
  sections.push(table([
    ["fixture", "metric", "value"],
    ...report.oneSidedTable.map((entry) => [entry.fixture, entry.metric, format(entry.value)]),
  ]));

  sections.push("## Acceptance targets");
  sections.push(table([
    ["target", "status", "measured", "note"],
    ...report.acceptance.map((entry) => [entry.target, entry.status, format(entry.measured), entry.note]),
  ]));

  sections.push("## Gates");
  const gates = [...report.gates.tier1, ...report.gates.tier2, ...report.gates.tier3];
  sections.push(table([
    ["tier", "gate", "passed", "detail"],
    ...gates.map((gate) => [String(gate.tier), gate.id, gate.waived ? "waived" : gate.passed ? "yes" : "NO", gate.detail]),
  ]));

  if (report.calibrationWarning) sections.push(`> **Calibration warning:** ${report.calibrationWarning}`);
  return sections.join("\n\n");
}
