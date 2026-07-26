/**
 * These travel with every report so the numbers can never be quoted without
 * them. Ordering is load-bearing: the first caveat undercuts the headline
 * metric, and burying it would defeat the purpose.
 */
export const CAVEATS: string[] = [
  "1. Gold-fact coverage is literal phrase presence anywhere in the bundle. A fact buried at token 8,000 of a 9,000-token transcript scores identically to a 40-token curated memory at rank 1. This systematically flatters full-history, and it is the metric on which RepoMind's advantage is claimed, so every coverage figure is an upper bound on usable knowledge and the comparison rests on the token-efficiency axis. firstGoldRank and mrrFact are published for every arm, including unranked ones, so burial is at least visible. No readability penalty is applied, because such a penalty would be unfalsifiable.",
  "2. This benchmark does not measure task success rate. No LLM is in the loop. Nothing here licenses a claim that RepoMind improves task success by any amount. The +15% success-rate target remains unverified and is reported as not-evaluated. taskSuccessRate, turnsToCompletion, wallClockTaskTimeMs, outputTokens, repeatedFileReads, repeatedFailedCommands, llmCostUsd, and embeddingCostUsd appear as explicit nulls with reasons, never as omissions.",
  "3. It measures context quality, not agent behavior. Whether an agent would use the delivered knowledge correctly is untested. A bundle can contain a fact the agent ignores; a bundle can omit a fact the agent trivially rediscovers. The load-bearing assumption that better context produces better outcomes is the product's premise, and this benchmark assumes it rather than testing it.",
  "4. approxTokens = ceil(chars / 4) is a documented heuristic, not a BPE count. Only ratios between arms are meaningful. The estimator's error is correlated with the arm, because full-history carries the diffs and JSON where characters per token diverge sharply from prose. Exact characters and a per-record-kind breakdown are published so anyone can recompute with a real tokenizer.",
  "5. flat-lexical-rag is a lower bound on flat RAG, not flat RAG. It has no embeddings because RepoMind has none. A real vector retriever would very likely beat it on paraphrase and cross-language retrieval, and might beat RepoMind there too. While the vector arm is unavailable those comparisons are reported as unresolved, never as RepoMind wins. Nothing here is evidence against vector retrieval.",
  "6. Metrics only RepoMind can score on are not falsifiability. overWarnRate, conflictNoiseShare, and evidenceCitationRate are one-sided by definition: other arms score zero because they lack the mechanism, not because they perform worse. They are absolute diagnostics, rendered separately, and never enter the win/loss ledger.",
  "7. Fixtures are authored by RepoMind's own authors. That is selection bias and no validator removes it. Mitigations are partial: hard failure conditions in fixture validation including a recomputed repository-discoverability check, fixtures that declare a designed loss which CI enforces, a versioned fixture schema, and an open invitation for externally contributed fixtures. Residual bias remains.",
  "8. The fixture count is small. Content metrics are exactly deterministic, so run-to-run variance is zero, which hides label and fixture-selection variance rather than eliminating them. A paired bootstrap 95% interval over fixtures is reported for every arm-to-arm delta, and the renderer refuses to print better when the interval crosses zero. At this sample size intervals are wide and small deltas are not results.",
  "9. residualExplorationFiles is a proxy. It is arithmetic over fixture-declared discoverability lists, not observed agent behavior.",
  "10. Latency figures are single-machine and single-OS, and at these corpus sizes are dominated by constant factors. Nothing in this suite gates on wall-clock time. The retrieval latency target at ten thousand memories is not demonstrated by any fixture here.",
  "11. The budget sweep uses round numbers, not measured real-world context budgets. Conclusions are ordinal, not calibrated to any specific agent's context window.",
  "12. This is not a public task set. The fixtures are fixed and reproducible, content-hashed into every report, but they are authored by this project and are not third-party. Every acceptance target is annotated as not being evaluated on a public task set.",
];

export const NOT_MEASURED = [
  { key: "taskSuccessRate", specRef: "20.3", reason: "No LLM agent in the loop; nothing executes the task." },
  { key: "turnsToCompletion", specRef: "20.3", reason: "No agent loop to count turns in." },
  { key: "wallClockTaskTimeMs", specRef: "20.3", reason: "No agent loop; assembly latency is not task time." },
  { key: "outputTokens", specRef: "20.3", reason: "Nothing generates output tokens." },
  { key: "repeatedFileReads", specRef: "20.3", reason: "Requires observing agent tool calls; residualExplorationFiles is a declared proxy." },
  { key: "repeatedFailedCommands", specRef: "20.3", reason: "Requires observing agent tool calls." },
  { key: "llmCostUsd", specRef: "20.3", reason: "No model is called." },
  { key: "embeddingCostUsd", specRef: "20.3", reason: "No embedding provider is configured." },
];

export const SPEC_COVERAGE = [
  { specMetric: "Task success rate", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: null, note: "Reported as not-evaluated." },
  { specMetric: "Turns and time to completion", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: null, note: "Reported as not-evaluated." },
  { specMetric: "Input tokens", section: "20.3" as const, measurability: "deterministic" as const, reportedAs: "approxTokens, tokensToCoverage", note: "Heuristic token estimate; exact characters also published." },
  { specMetric: "Output tokens", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: null, note: "Nothing generates output." },
  { specMetric: "Repeated file reads", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: "residualExplorationFiles", note: "Declared proxy, not observed behavior." },
  { specMetric: "Repeated failed commands", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: null, note: "Requires observing agent tool calls." },
  { specMetric: "Relevant memory recall@K", section: "20.3" as const, measurability: "deterministic" as const, reportedAs: "answerCoverage, mrrFact", note: "Phrase-presence based; see caveat 1." },
  { specMetric: "Irrelevant memory share", section: "20.3" as const, measurability: "deterministic" as const, reportedAs: "noiseShare", note: null },
  { specMetric: "Stale memory misuse rate", section: "20.3" as const, measurability: "deterministic" as const, reportedAs: "unwarnedStaleRate", note: "Split into file-detectable and prose-only; only the former is gated." },
  { specMetric: "Evidence citation correctness", section: "20.3" as const, measurability: "deterministic" as const, reportedAs: "evidenceCitationRate", note: "One-sided: other arms have no evidence layer." },
  { specMetric: "LLM and embedding cost per task", section: "20.3" as const, measurability: "requires-llm" as const, reportedAs: null, note: "No provider configured." },
];
