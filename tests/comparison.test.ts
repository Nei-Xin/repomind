import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../src/eval/comparison/fixture.js";
import { matchesFact } from "../src/eval/comparison/score.js";
import { approxTokens, packToBudget } from "../src/eval/comparison/pack.js";
import { mulberry32, pairedBootstrapCi } from "../src/eval/comparison/stats.js";
import { lintFixtures, runComparison } from "../src/eval/comparison/runner.js";
import { parseFixture } from "../src/eval/comparison/fixture.js";
import type { ContextRecord } from "../src/eval/comparison/types.js";

const SMOKE = ["reuse-debug-experience"];

function smokeFixtures(): Array<{ fixture: ReturnType<typeof parseFixture>; sha256: string }> {
  return SMOKE
    .map((name) => `benchmarks/comparison/${name}.json`)
    .filter((path) => globSync(path).length)
    .map((path) => loadFixture(path));
}

describe("packing and token accounting", () => {
  const records: ContextRecord[] = [
    { kind: "repo_base", text: "a".repeat(40) },
    { kind: "memory", text: "b".repeat(40) },
    { kind: "memory", text: "c".repeat(40) },
  ];

  it("separates repository tokens from memory tokens", () => {
    const bundle = packToBudget("repomind", records, Number.POSITIVE_INFINITY);
    expect(bundle.repoTokens).toBe(10);
    expect(bundle.memoryTokens).toBe(20);
    expect(bundle.approxTokens).toBe(30);
    expect(bundle.charsByKind).toEqual({ repo_base: 40, memory: 80 });
  });

  it("never cuts a record in half", () => {
    const bundle = packToBudget("repomind", records, 15);
    expect(bundle.truncated).toBe(true);
    expect(bundle.records.map((record) => record.text.length)).toEqual([40]);
    expect(bundle.chars).toBe(40);
  });

  it("estimates tokens from characters as documented", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
  });
});

describe("gold fact matching", () => {
  it("requires every allOf phrase and one phrase from each anyOf group", () => {
    const fact = {
      key: "f", matcher: { allOf: ["reset the database"], anyOf: [["between cases", "per case"]] },
      status: "current" as const, supportedBy: ["s1"], requiredFor: "success" as const, repoDiscoverable: false,
    };
    expect(matchesFact(fact, "We reset the database between cases.")).toBe(true);
    expect(matchesFact(fact, "We reset the database once.")).toBe(false);
    expect(matchesFact(fact, "Nothing relevant.")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    const fact = {
      key: "f", matcher: { allOf: ["reset the database"] },
      status: "current" as const, supportedBy: ["s1"], requiredFor: "success" as const, repoDiscoverable: false,
    };
    expect(matchesFact(fact, "RESET   THE\nDATABASE")).toBe(true);
  });

  it("never matches an empty matcher", () => {
    const fact = {
      key: "f", matcher: {}, status: "current" as const,
      supportedBy: ["s1"], requiredFor: "success" as const, repoDiscoverable: false,
    };
    expect(matchesFact(fact, "anything at all")).toBe(false);
  });
});

describe("bootstrap statistics", () => {
  it("is deterministic for a given seed", () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it("refuses a verdict when the interval crosses zero", () => {
    const noisy = pairedBootstrapCi([{ a: 1, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 0 }, { a: 0, b: 1 }], true);
    expect(noisy?.verdict).toBe("indistinguishable");
  });

  it("reports a direction when every pair agrees", () => {
    const clear = pairedBootstrapCi([{ a: 1, b: 0 }, { a: 1, b: 0 }, { a: 0.9, b: 0.1 }, { a: 1, b: 0.2 }], true);
    expect(clear?.verdict).toBe("A better");
    expect(clear?.ci95[0]).toBeGreaterThan(0);
  });

  it("returns null when there is not enough data to resample", () => {
    expect(pairedBootstrapCi([{ a: 1, b: 0 }], true)).toBeNull();
  });
});

describe("fixture schema", () => {
  it("rejects unknown keys", () => {
    expect(() => parseFixture({ fixtureVersion: 1, name: "x", unknown: true }, "inline")).toThrow(/Invalid fixture/);
  });

  it("rejects a fixture version it does not understand", () => {
    expect(() => parseFixture({ fixtureVersion: 2, name: "x" }, "inline")).toThrow(/Invalid fixture/);
  });
});

describe("comparison run", () => {
  const fixtures = smokeFixtures();

  it.runIf(fixtures.length)("passes every hard validation check on the smoke fixtures", () => {
    expect(lintFixtures(fixtures).every((entry) => entry.ok)).toBe(true);
  }, 120_000);

  it.runIf(fixtures.length)("produces identical bundles regardless of arm order", () => {
    const forward = runComparison({ fixtures, budgets: [Number.POSITIVE_INFINITY], arms: ["repomind-nogov", "repomind"], alphaSweep: false });
    const reversed = runComparison({ fixtures, budgets: [Number.POSITIVE_INFINITY], arms: ["repomind", "repomind-nogov"], alphaSweep: false });
    const shape = (report: typeof forward) =>
      [...report.cells].sort((a, b) => `${a.fixture}${a.arm}`.localeCompare(`${b.fixture}${b.arm}`))
        .map((cell) => ({ arm: cell.arm, fixture: cell.fixture, chars: cell.bundle.chars, metrics: cell.metrics }));
    // Catches a missing database restore: search writes staleness state, so a
    // shared database would make arm order change the governance delta.
    expect(shape(forward)).toEqual(shape(reversed));
  }, 300_000);

  it.runIf(fixtures.length)("reports honesty sections and never claims an unevaluated target", () => {
    const report = runComparison({ fixtures, budgets: [Number.POSITIVE_INFINITY], arms: ["no-memory", "full-history", "repomind"], alphaSweep: false });
    expect(report.caveats.length).toBe(12);
    expect(report.notMeasured.length).toBeGreaterThan(0);
    expect(report.acceptance.find((entry) => entry.target.includes("Task success rate"))).toMatchObject({
      status: "not-evaluated",
      taskSetIsPublic: false,
    });
    expect(report.arms.find((arm) => arm.key === "flat-vector-rag")).toMatchObject({ status: "unavailable" });
    expect(report.arms.find((arm) => arm.key === "repomind-layered-hybrid")).toMatchObject({ status: "not-implemented" });
    expect(report.gates.tier1.every((gate) => gate.passed)).toBe(true);
  }, 300_000);

  it.runIf(fixtures.length)("repeats latency sampling without duplicating scored cells", () => {
    const report = runComparison({
      fixtures,
      budgets: [Number.POSITIVE_INFINITY],
      arms: ["no-memory"],
      repeat: 3,
      alphaSweep: false,
    });
    expect(report.header.repeat).toBe(3);
    expect(report.cells).toHaveLength(fixtures.length);
    expect(report.latency?.samples).toBe(report.cells.length * 3);
  }, 300_000);

  it.runIf(fixtures.length)("rejects invalid repeat counts", () => {
    expect(() => runComparison({ fixtures, repeat: 0 })).toThrow(/between 1 and 100/);
    expect(() => runComparison({ fixtures, repeat: 1.5 })).toThrow(/between 1 and 100/);
    expect(() => runComparison({ fixtures, repeat: 101 })).toThrow(/between 1 and 100/);
  });
});
