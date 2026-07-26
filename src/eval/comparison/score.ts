import { lexicalTerms } from "../../search/lexical.js";
import type { Fixture, GoldFact } from "./fixture.js";
import { approxTokens } from "./pack.js";
import type { ContextBundle, ContextRecord, MetricDefinition } from "./types.js";

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ");
}

/** A gold fact is covered when its matcher is satisfied by the given text. */
export function matchesFact(fact: GoldFact, text: string): boolean {
  const haystack = normalize(text);
  const allOf = fact.matcher.allOf ?? [];
  if (allOf.length && !allOf.every((phrase) => haystack.includes(normalize(phrase)))) return false;
  const anyOf = fact.matcher.anyOf ?? [];
  if (anyOf.length && !anyOf.every((group) => group.some((phrase) => haystack.includes(normalize(phrase))))) return false;
  return allOf.length > 0 || anyOf.length > 0;
}

function firstCoveringRank(fact: GoldFact, records: ContextRecord[]): number {
  for (let index = 0; index < records.length; index++) {
    if (matchesFact(fact, records[index]!.text)) return index + 1;
  }
  return 0;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface BundleMetrics {
  answerCoverage: number;
  requiredCoverage: number;
  coveredGoldFacts: number;
  totalGoldFacts: number;
  tokensToCoverage: number | null;
  firstGoldRank: number;
  mrrFact: number;
  noiseShare: number;
  emptyTaskNoiseTokens: number | null;
  redundancyRate: number;
  unwarnedStaleRate: number | null;
  unwarnedStaleRateFileDetectable: number | null;
  unwarnedStaleRateProseOnly: number | null;
  conflictWarnedRate: number | null;
  supersededLeakRate: number;
  overWarnRate: number | null;
  evidenceCitationRate: number;
  conflictNoiseShare: number;
  residualExplorationFiles: number;
  capBound: number;
}

export const METRIC_CATALOG: MetricDefinition[] = [
  { key: "answerCoverage", measurementClass: "comparative", formula: "coveredGoldFacts / totalGoldFacts", specRef: "20.3 recall@k" },
  { key: "requiredCoverage", measurementClass: "comparative", formula: "covered facts with requiredFor=success / all such facts", specRef: "20.3" },
  { key: "tokensToCoverage", measurementClass: "comparative", formula: "approxTokens of the prefix reaching full required coverage, null if never", specRef: "20.3 input tokens" },
  { key: "firstGoldRank", measurementClass: "comparative", formula: "1-based position of the first record covering any gold fact, 0 if none", specRef: null },
  { key: "mrrFact", measurementClass: "comparative", formula: "1 / firstGoldRank, 0 if none", specRef: "20.3 recall@k" },
  { key: "noiseShare", measurementClass: "comparative", formula: "tokens of records covering no gold fact / memoryTokens", specRef: "20.3 irrelevant memory share" },
  { key: "emptyTaskNoiseTokens", measurementClass: "comparative", formula: "memoryTokens when the fixture declares no gold facts, else null", specRef: "20.2 no-relevant-memory" },
  { key: "redundancyRate", measurementClass: "comparative", formula: "packed records with term Jaccard >= 0.8 against an earlier record / packed records", specRef: null },
  { key: "unwarnedStaleRate", measurementClass: "comparative", formula: "stale gold facts present without any warning on their record / stale gold facts present", specRef: "20.4 stale misuse" },
  { key: "conflictWarnedRate", measurementClass: "comparative", formula: "conflicted gold facts whose record carries a conflict marker / conflicted gold facts present", specRef: "20.2 conflicting conclusions" },
  { key: "supersededLeakRate", measurementClass: "definitional", formula: "packed memory records with status superseded or invalid / packed memory records", specRef: "RET-006" },
  { key: "overWarnRate", measurementClass: "one-sided", formula: "current gold facts inside a warned record / current gold facts present", specRef: null },
  { key: "evidenceCitationRate", measurementClass: "one-sided", formula: "packed memory records with a resolvable evidence pointer / packed memory records", specRef: "20.4 evidence binding" },
  { key: "conflictNoiseShare", measurementClass: "one-sided", formula: "tokens of conflict-warned records covering no gold fact / memoryTokens", specRef: null },
  { key: "residualExplorationFiles", measurementClass: "proxy", formula: "deduplicated union of discoverableFrom over uncovered gold facts", specRef: "20.4 repeated exploration" },
];

export function scoreBundle(fixture: Fixture, bundle: ContextBundle): BundleMetrics {
  const facts = fixture.goldFacts;
  const bundleText = bundle.records.map((record) => record.text).join("\n");
  const covered = facts.filter((fact) => matchesFact(fact, bundleText));
  const required = facts.filter((fact) => fact.requiredFor === "success");
  const requiredCovered = required.filter((fact) => matchesFact(fact, bundleText));

  // Prefix scan: the token cost at which every required fact is first present.
  let tokensToCoverage: number | null = null;
  if (required.length) {
    let prefix = "";
    let tokens = 0;
    for (const record of bundle.records) {
      prefix += `\n${record.text}`;
      tokens += approxTokens(record.text);
      if (required.every((fact) => matchesFact(fact, prefix))) {
        tokensToCoverage = tokens;
        break;
      }
    }
  }

  const firstRank = facts.length
    ? Math.min(...facts.map((fact) => firstCoveringRank(fact, bundle.records)).filter((rank) => rank > 0), Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
  const firstGoldRank = Number.isFinite(firstRank) ? firstRank : 0;

  const memoryRecords = bundle.records.filter((record) => record.kind === "memory");
  const nonRepo = bundle.records.filter((record) => record.kind !== "repo_base" && record.kind !== "repo_chunk");
  const noiseTokens = nonRepo
    .filter((record) => !facts.some((fact) => matchesFact(fact, record.text)))
    .reduce((sum, record) => sum + approxTokens(record.text), 0);

  const seen: Array<Set<string>> = [];
  let redundant = 0;
  for (const record of bundle.records) {
    const terms = new Set(lexicalTerms(record.text));
    if (seen.some((earlier) => jaccard(terms, earlier) >= 0.8)) redundant++;
    seen.push(terms);
  }

  const staleFacts = facts.filter((fact) => fact.status === "stale");
  const staleRate = (subset: GoldFact[]): number | null => {
    const present = subset.filter((fact) => matchesFact(fact, bundleText));
    if (!present.length) return null;
    const unwarned = present.filter((fact) =>
      !bundle.records.some((record) => record.warned && matchesFact(fact, record.text)));
    return unwarned.length / present.length;
  };

  const conflicted = facts.filter((fact) => fact.status === "conflicted");
  const conflictedPresent = conflicted.filter((fact) => matchesFact(fact, bundleText));
  const conflictWarnedRate = conflictedPresent.length
    ? conflictedPresent.filter((fact) => bundle.records.some((record) => record.warned && matchesFact(fact, record.text))).length / conflictedPresent.length
    : null;

  const currentFacts = facts.filter((fact) => fact.status === "current");
  const currentPresent = currentFacts.filter((fact) => matchesFact(fact, bundleText));
  const overWarnRate = currentPresent.length
    ? currentPresent.filter((fact) => bundle.records.some((record) => record.warned && matchesFact(fact, record.text))).length / currentPresent.length
    : null;

  const uncoveredFiles = new Set<string>();
  for (const fact of facts) {
    if (covered.includes(fact)) continue;
    for (const file of fact.discoverableFrom ?? []) uncoveredFiles.add(file);
  }

  const conflictNoiseTokens = bundle.records
    .filter((record) => record.warned && !facts.some((fact) => matchesFact(fact, record.text)))
    .reduce((sum, record) => sum + approxTokens(record.text), 0);

  return {
    answerCoverage: facts.length ? covered.length / facts.length : 1,
    requiredCoverage: required.length ? requiredCovered.length / required.length : 1,
    coveredGoldFacts: covered.length,
    totalGoldFacts: facts.length,
    tokensToCoverage,
    firstGoldRank,
    mrrFact: firstGoldRank ? 1 / firstGoldRank : 0,
    noiseShare: bundle.memoryTokens ? noiseTokens / bundle.memoryTokens : 0,
    emptyTaskNoiseTokens: facts.length ? null : bundle.memoryTokens,
    redundancyRate: bundle.records.length ? redundant / bundle.records.length : 0,
    unwarnedStaleRate: staleRate(staleFacts),
    unwarnedStaleRateFileDetectable: staleRate(staleFacts.filter((fact) => fact.staleDetectability === "file-hash")),
    unwarnedStaleRateProseOnly: staleRate(staleFacts.filter((fact) => fact.staleDetectability === "prose-only")),
    conflictWarnedRate,
    supersededLeakRate: memoryRecords.length
      ? memoryRecords.filter((record) => record.memoryStatus === "superseded" || record.memoryStatus === "invalid").length / memoryRecords.length
      : 0,
    overWarnRate,
    evidenceCitationRate: memoryRecords.length
      ? memoryRecords.filter((record) => record.hasEvidence).length / memoryRecords.length
      : 0,
    conflictNoiseShare: bundle.memoryTokens ? conflictNoiseTokens / bundle.memoryTokens : 0,
    residualExplorationFiles: uncoveredFiles.size,
    capBound: bundle.capBound ? 1 : 0,
  };
}
