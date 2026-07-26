# Retrieval benchmark

`repomind eval` measures retrieval quality against a fixed, versioned dataset. It is the first building block of the staged benchmark plan (`REPOMIND_PROJECT_PLAN.md` section 32): it quantifies whether search finds the right memories, before the larger task-level comparison (no memory vs. flat RAG vs. RepoMind) is built.

## How it works

1. The dataset (`benchmarks/datasets/*.json`) declares seed memories and queries. Each query lists the memory titles that count as relevant.
2. The runner creates a throwaway Git repository and a throwaway data directory, so results are reproducible and never touch existing repository memories.
3. Every memory is recorded through the normal `record` path (including redaction, FTS indexing, and conflict detection), then every query runs through the normal `search` path.
4. The report states, per query and in aggregate:
   - **Recall@K** — the fraction of expected memories present in the top K results (K = `--limit`, default 5).
   - **MRR** — mean reciprocal rank of the first relevant result.
   - **latency** — wall-clock `search` time, reported as P50/P95 across queries.
   - **missedQueries** — every query that failed to retrieve an expected memory. Misses are reported, never padded over.

## Run it

```bash
repomind eval --dataset benchmarks/datasets/basic-retrieval.json --json
```

## Example result

Measured on Windows 11, Node.js 22.20, 10 seeded memories, 8 queries, K = 5:

```json
{
  "queries": 8,
  "meanRecallAtK": 1,
  "mrr": 0.938,
  "p50LatencyMs": 0.614,
  "p95LatencyMs": 1.771,
  "missedQueries": []
}
```

Latency numbers depend on hardware and data volume; always report OS, Node version, and dataset size next to them. The spec target (FTS P95 < 150 ms at 10,000 memories) is a goal, and this 10-memory dataset does not demonstrate it.

## Cross-session scenario suite

`repomind eval --scenarios` replays six end-to-end scenarios, each in its own throwaway repository, and reports the deterministic targets from the final product spec (section 20.4) that do not require an LLM:

| Scenario | Verifies | Spec target |
| --- | --- | --- |
| cross-session-recall | A new core instance recalls the previous session's memory with evidence | recall works across sessions |
| evidence-binding | Every stored memory references at least one evidence row | binding rate 100% |
| repository-isolation | Searches never return another repository's memories | contamination 0% |
| stale-warning | A changed related file yields an `uncertain` result with a warning | unwarned stale use < 5% |
| conflict-surfacing | Contradicting decisions both surface with explicit conflict warnings | no silent merging |
| idempotent-commit | Repeating a commit with the same key creates nothing new | no duplicates |

Current result (all scenarios pass):

```json
{
  "scenarios": 6,
  "passed": 6,
  "failed": 0,
  "crossSessionRecall": 1,
  "evidenceBindingRate": 1,
  "isolationViolations": 0,
  "staleWarnedRate": 1,
  "conflictSurfacedRate": 1,
  "idempotencyViolations": 0
}
```

## Known limitations

- The dataset is small and hand-written; it validates the retrieval pipeline, not end-to-end agent benefit.
- The scenario suite verifies mechanism guarantees deterministically; it does not measure agent task success or token savings.
- The comparison benchmark from the spec is built: `repomind eval --compare` scores the **context bundle** each memory strategy delivers under a fixed token budget, across six scoring arms and five budgets. See [`benchmark-comparison.md`](./benchmark-comparison.md).
- What it still does **not** measure, because no LLM is in the loop: task success rate, turns to completion, wall-clock task time, output tokens, and real BPE or dollar cost. The "+15% task success" target is reported as `not-evaluated`, never as met.
- Two acceptance targets are measured deterministically: unwarned stale-memory use (gated in CI for file-detectable staleness only — the file-hash detector is structurally blind to retractions stated only in prose) and 100% evidence binding.
- There is no vector retrieval mode to compare against until embeddings land. The `flat-vector-rag` arm's contract is fixed and it reports `available: false`; paraphrase and cross-language comparisons are unresolved rather than credited to RepoMind.
