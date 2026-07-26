import { RepoMindError } from "../../errors.js";
import { lexicalTerms } from "../../search/lexical.js";
import type { RawCorpus } from "./corpus.js";
import type { Fixture } from "./fixture.js";
import { matchesFact } from "./score.js";
import type { ContextRecord } from "./types.js";

function fail(fixture: Fixture, check: string, detail: string): never {
  throw new RepoMindError("INVALID_INPUT", `Fixture ${fixture.name} failed check ${check}: ${detail}`);
}

/**
 * Hard failure conditions. Every one of these throws rather than warning,
 * because a fixture that quietly measures nothing is worse than a missing one:
 * it produces a confident number backed by nothing.
 */
export function validateFixture(
  fixture: Fixture,
  corpus: RawCorpus,
  repoBase: ContextRecord[],
  repoFiles: Map<string, string>,
): void {
  const corpusText = corpus.text();
  const repoText = [...repoFiles.entries()].map(([path, content]) => `${path}\n${content}`).join("\n");
  const baseText = repoBase.map((record) => record.text).join("\n");

  for (const fact of fixture.goldFacts) {
    // 1. A fact nobody could know is a bug in the fixture, not a hard task.
    if (!matchesFact(fact, corpusText) && !matchesFact(fact, repoText)) {
      fail(fixture, "1-unknowable", `gold fact ${fact.key} matches neither the corpus nor the repository`);
    }
    // 2. A fact already stated in the query measures nothing.
    if (matchesFact(fact, fixture.query)) {
      fail(fixture, "2-trivial", `gold fact ${fact.key} is satisfied by the query itself`);
    }
    // 3. A file-detectable stale fact needs a mutation that actually changes a file.
    if (fact.status === "stale" && fact.staleDetectability === "file-hash" && !(fixture.mutations ?? []).length) {
      fail(fixture, "3-stale-unmutated", `gold fact ${fact.key} claims file-hash staleness but the fixture mutates nothing`);
    }
    // 4. Anti-cheat: decision text is copied verbatim into memories, so a fact
    // satisfiable only from a decision chunk is trivially reachable for RepoMind.
    if (!fact.decisionOnly) {
      const nonDecision = corpus.chunks.filter((chunk) => chunk.kind !== "decision").map((chunk) => chunk.text).join("\n");
      if (matchesFact(fact, corpusText) && !matchesFact(fact, nonDecision) && !matchesFact(fact, repoText)) {
        fail(fixture, "4-decision-only", `gold fact ${fact.key} is satisfiable only from decision text; set decisionOnly if intended`);
      }
    }
    // 6. A declared repoDiscoverable value must match what the repository holds.
    const computed = matchesFact(fact, repoText) || matchesFact(fact, baseText);
    if (computed !== fact.repoDiscoverable) {
      fail(fixture, "6-repo-discoverable", `gold fact ${fact.key} declares repoDiscoverable=${fact.repoDiscoverable} but the repository says ${computed}`);
    }
  }

  // 7. A paraphrase or cross-language fixture must share no lexical stem with
  // the gold session text, or it is not testing paraphrase recall at all.
  if (fixture.category === "paraphrase-recall" || fixture.category === "cjk-query") {
    const queryTerms = new Set(lexicalTerms(fixture.query));
    const goldSessions = new Set(fixture.goldFacts.flatMap((fact) => fact.supportedBy));
    const goldText = corpus.chunks.filter((chunk) => goldSessions.has(chunk.sessionId)).map((chunk) => chunk.text).join("\n");
    const shared = [...new Set(lexicalTerms(goldText))].filter((term) => queryTerms.has(term));
    if (shared.length) {
      fail(fixture, "7-lexical-overlap", `query shares stems with the gold session: ${shared.slice(0, 5).join(", ")}`);
    }
  }

  // 8. Declared gates must name a real arm and a metric of the right class.
  const comparative = new Set([
    "answerCoverage", "requiredCoverage", "tokensToCoverage", "firstGoldRank", "mrrFact",
    "noiseShare", "emptyTaskNoiseTokens", "redundancyRate", "unwarnedStaleRate", "conflictWarnedRate",
  ]);
  const oneSided = new Set(["overWarnRate", "evidenceCitationRate", "conflictNoiseShare"]);
  for (const loss of fixture.designedLoss ?? []) {
    if (!comparative.has(loss.metric)) fail(fixture, "8-gate-metric", `designedLoss metric ${loss.metric} is not comparative`);
  }
  for (const cost of fixture.designedCost ?? []) {
    if (!oneSided.has(cost.metric)) fail(fixture, "8-gate-metric", `designedCost metric ${cost.metric} is not one-sided`);
  }

  // 9. Without distractors, retrieval is trivially perfect for every arm.
  const queryTerms = new Set(lexicalTerms(fixture.query));
  const goldSessions = new Set(fixture.goldFacts.flatMap((fact) => fact.supportedBy));
  const distractors = fixture.history.filter((session) => !goldSessions.has(session.id));
  const overlapping = distractors.filter((session) => {
    const terms = new Set(lexicalTerms(`${session.task} ${session.summary}`));
    if (!terms.size) return false;
    let shared = 0;
    for (const term of terms) if (queryTerms.has(term)) shared++;
    return shared / terms.size >= 0.05;
  });
  if (fixture.goldFacts.length && overlapping.length < 3) {
    fail(fixture, "9-distractors", `needs at least 3 distractor sessions overlapping the query, found ${overlapping.length}`);
  }
}

/**
 * 10. Aggregate check across the fixture set.
 *
 * Enforced only for a complete run: a targeted subset legitimately skews, and
 * blocking those runs would push people toward not running the benchmark at
 * all. Subset runs still report the share through the tier-3 gate.
 */
export function validateFixtureSet(fixtures: Fixture[], enforce: boolean): void {
  if (!fixtures.length || !enforce) return;
  const adversarialShare = fixtures.filter((fixture) => fixture.adversarial).length / fixtures.length;
  if (adversarialShare < 0.375) {
    throw new RepoMindError("INVALID_INPUT",
      `Adversarial fixture share is ${adversarialShare.toFixed(3)}, below the 0.375 floor; the fixture set is too favorable`);
  }
}
