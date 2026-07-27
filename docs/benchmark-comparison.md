# Comparison benchmark

`repomind eval --compare` answers one question: **given the same task and the
same token budget, what context does each memory strategy actually deliver?**

It does not answer whether an agent then succeeds. Read
[Conclusions this benchmark does not support](#conclusions-this-benchmark-does-not-support)
before quoting any number from it.

```bash
repomind eval --compare --json
repomind eval --compare --markdown
repomind eval --compare --lint            # validate fixtures only
repomind eval --compare --strict          # non-zero exit if a gate fails
repomind eval --compare --repeat 10        # collect ten latency samples per evaluation unit
```

`--repeat` accepts an integer from 1 through 100. Repetition rebuilds the same
context bundle from the same database snapshot and records an independent
latency sample each time. Deterministic content metrics retain one scoring cell
per fixture, arm, placement, alpha, and budget, so increasing `--repeat` does
not inflate the statistical sample size used for quality comparisons. The
report's `latency.samples` field records the resulting raw sample count.

## The arms

Every arm receives the same repository base — README excerpt, package scripts,
and a shallow file listing — so token deltas are attributable to the memory
layer rather than to how much repository context an arm happens to bundle.

| Arm | What it is |
| --- | --- |
| `no-memory` | No memory database at all, but not helpless: BM25 retrieval over repository file chunks, using the same tokenizer and ranker RepoMind uses. An agent without memory still greps. |
| `full-history` | Every session rendered whole, newest first, unfiltered and unflagged. Not ignorant — it contains every fact the corpus holds. Its cost is tokens and noise. |
| `flat-lexical-rag` | BM25 over raw session text with a recency weight and no governance. The weight is swept over five values and the best is reported, so the baseline is judged at its strongest. |
| `recency-k` | The most recently updated live memories. No query, no ranking, no relevance signal. Exists to ask whether the retrieval machinery earns its keep. |
| `repomind-nogov` | RepoMind's curation with governance switched off: every status eligible, no staleness refresh, no warnings. Isolates curation from governance. |
| `repomind` | `core.search` exactly as an agent gets it. |
| `oracle-ceiling` | The fixture's gold facts, minimally rendered. A reference scale, never in the win/loss ledger. |
| `flat-vector-rag` | sqlite-vec cosine retrieval over raw session chunks using the deterministic offline feature-hash provider. |
| `repomind-layered-hybrid` | Weighted lexical/vector reciprocal-rank fusion over governed L1 memories. L2/L3 layers remain future work. |

The lexical arms call the same `buildMatchExpression` and `searchTokens` that
production search calls. A baseline cannot drift into a strawman without
changing the code RepoMind itself runs on.

## What is measured

**Comparative** metrics are where arms genuinely compete: `answerCoverage`,
`tokensToCoverage`, `mrrFact`, `noiseShare`, `redundancyRate`,
`unwarnedStaleRate`, `conflictWarnedRate`. Only these enter the win/loss
ledger.

**One-sided** metrics — `overWarnRate`, `evidenceCitationRate`,
`conflictNoiseShare` — measure mechanisms only RepoMind has. Other arms score
zero because they lack the mechanism, not because they perform worse. These are
absolute diagnostics (how often does RepoMind cry wolf; how much budget does
conflict marking burn) and they are rendered in a separate column that never
counts as a win.

Deltas carry a paired bootstrap 95% interval over fixtures, and the renderer
prints `indistinguishable` rather than "better" whenever the interval crosses
zero.

## How a fixture works

A fixture declares a repository, a session history, optional governance
operations and file mutations, a query, and the gold facts an ideal bundle
would contain. Replay writes every session through the public API —
`startSession` / `commitSession` / `record` / the governance methods — never
through direct SQL. That makes the benchmark an integration test of the write
path: a governance bug surfaces as a loud build failure rather than a silently
favorable zero.

Each history session is written to the raw corpus and committed to RepoMind in
the same loop iteration, so information parity is structural. Any fact
RepoMind's extractor drops is still visible to every other arm, and counts as a
RepoMind loss.

Ten hard checks reject a fixture outright, including: a gold fact that matches
nothing; a gold fact already stated in the query; a fact reachable only through
decision text, which RepoMind copies verbatim and would therefore find
trivially; and a declared repository-discoverability flag that disagrees with a
recomputation. A fixture that quietly measures nothing is worse than a missing
one.

## The honesty gates

Tier 1 fails on absolute breakage: a fixture that could not be replayed, a
retired memory reaching a bundle, a packed memory with no evidence.

Tier 2 checks the deterministic acceptance targets. Unwarned use of
file-detectable stale memories is gated below 5%. The prose-only variant is
**reported and deliberately not gated**: file-hash staleness detection is
structurally blind to a conclusion retracted in later prose, and hiding that
behind an aggregate would be dishonest.

Tier 3 is the anti-self-serving core. Fixtures declare a `designedLoss` naming
an arm that must beat RepoMind on a named metric, or a `designedCost` naming a
one-sided metric that must exceed a floor. If RepoMind wins a fixture that was
built to defeat it, the gate fails with `the fixture is not stressing what it
claims`. The run also fails if RepoMind lost nothing anywhere, if the caveats
are missing, or if the adversarial fixture share drops below 0.375.

A `designedLoss` can be waived only through an explicit `waivers` entry with a
reason and a bumped fixture version — otherwise anyone who genuinely improves
RepoMind (landing embeddings, say) would break the build, and the gate would be
punishing progress.

## Conclusions this benchmark does not support

> **1. Gold-fact coverage is literal phrase presence anywhere in the bundle.** A
> fact buried at token 8,000 of a 9,000-token transcript scores identically to a
> 40-token curated memory at rank 1. This systematically flatters
> `full-history`, and it is the metric on which RepoMind's advantage is claimed,
> so every coverage figure is an upper bound on *usable* knowledge and the whole
> comparison rests on the token-efficiency axis. `firstGoldRank` and `mrrFact`
> are published for every arm, including the unranked ones, so burial is at
> least visible. No readability penalty is applied, because such a penalty would
> be unfalsifiable.
>
> **2. This benchmark does not measure task success rate.** No LLM is in the
> loop. Nothing here licenses "RepoMind improves task success by X%". The +15%
> success-rate target remains unverified and is reported as `not-evaluated`.
> `taskSuccessRate`, `turnsToCompletion`, `wallClockTaskTimeMs`, `outputTokens`,
> `repeatedFileReads`, `repeatedFailedCommands`, `llmCostUsd`, and
> `embeddingCostUsd` appear as explicit nulls with reasons, never as omissions.
>
> **3. It measures context quality, not agent behavior.** Whether an agent would
> then use the delivered knowledge correctly is untested. A bundle can contain a
> fact the agent ignores; a bundle can omit a fact the agent trivially
> rediscovers. The load-bearing assumption — that better context produces better
> outcomes — is the product's entire premise, and this benchmark assumes it
> rather than testing it.
>
> **4. `approxTokens = ceil(chars / 4)` is a documented heuristic, not a BPE
> count.** Only ratios between arms are meaningful. The estimator's error is
> correlated with the arm, because `full-history` is the arm carrying git diffs
> and JSON blobs where characters-per-token diverges sharply from prose. Exact
> characters and a per-record-kind breakdown are published so anyone can
> recompute with a real tokenizer.
>
> **5. The vector arms use a deterministic feature-hash embedding.** This keeps
> sqlite-vec retrieval offline and reproducible, but it is not a learned
> semantic model. The results do not estimate the quality, latency, or cost of
> an OpenAI-compatible embedding provider and must not be generalized to one.
>
> **6. Metrics only RepoMind can score on are not falsifiability.**
> `overWarnRate`, `conflictNoiseShare`, and `evidenceCitationRate` are one-sided
> by definition: other arms score zero because they lack the mechanism, not
> because they perform worse. They are absolute diagnostics, rendered
> separately, and never enter the win/loss ledger.
>
> **7. Fixtures are authored by RepoMind's own authors.** That is selection bias
> and no validator removes it. The mitigations are partial: ten hard failure
> conditions including a recomputed repository-discoverability check, fixtures
> that declare a designed loss which CI enforces, a versioned fixture schema, and
> an open invitation for externally contributed fixtures. Residual bias remains.
>
> **8. The fixture count is small.** Content metrics are exactly deterministic,
> so run-to-run variance is zero — which hides label variance and fixture
> selection variance rather than eliminating them. A paired bootstrap 95%
> interval over fixtures is reported for every delta, and the renderer refuses to
> print "better" when the interval crosses zero. At this sample size the
> intervals are wide and small deltas are not results.
>
> **9. `residualExplorationFiles` is a proxy.** It is arithmetic over
> fixture-declared discoverability lists, not observed agent behavior.
>
> **10. Latency figures are single-machine and single-OS**, and at these corpus
> sizes are dominated by constant factors. Nothing in this suite gates on
> wall-clock time. The retrieval latency target at ten thousand memories is not
> demonstrated by any fixture here.
>
> **11. The budget sweep uses round numbers**, not measured real-world context
> budgets. Conclusions are ordinal, not calibrated to any specific agent's
> context window.
>
> **12. This is not a public task set.** The fixtures are fixed and reproducible
> — content-hashed into every report — but they are authored by this project and
> are not third-party. Every acceptance target is annotated
> `taskSetIsPublic: false`.

## Contributing a fixture

External fixtures are the only real fix for caveat 7. Copy
`benchmarks/comparison/reuse-debug-experience.json`, and run
`repomind eval --compare --fixtures <your-file> --lint` until it passes. A
fixture that defeats RepoMind is more valuable than one it wins.
