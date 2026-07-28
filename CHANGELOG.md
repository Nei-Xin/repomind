# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, minor releases may change behavior; every such change is listed
under **Changed** with its migration impact.

## [Unreleased]

## [0.9.0] - 2026-07-28

### Added

- `repomind run --task <text>` as a daily OpenCode entry point for the
  host-managed lifecycle. It retrieves memory before Agent execution, injects
  the evidence-backed context, captures OpenCode JSON events, and commits
  command and test evidence without exposing RepoMind MCP to the model loop.
- Abort, timeout, spawn-failure, and output-setup cleanup for daily runs. A
  process that does not complete normally abandons its RepoMind session rather
  than leaving it open; normal nonzero Agent exits are committed as failed
  sessions so their evidence remains inspectable.
- Redacted run artifacts under the RepoMind data directory, including Agent
  events, stderr, and a machine-readable lifecycle report with phase status,
  retrieval count, exit code, event metrics, and commit result.
- A rebuildable eight-task `repomind run` acceptance harness that creates fresh
  fixed-commit fixtures, seeds isolated memories, exercises the daily
  host-managed runner, applies external public and hidden checks, validates
  artifacts and session cleanup, and writes JSON and Markdown summaries.

### Security

- Daily host-managed runs overlay OpenCode configuration in memory, disable the
  conventional `mcp.repomind` entry, run with external plugins disabled, and
  redact captured output before display or persistence. User project
  configuration files are not modified.

### Validation

- The rebuildable daily-run acceptance completed all eight OpenCode tasks with
  integrity and acceptance passing: 8/8 retrieved memory, exited cleanly,
  committed sessions, and passed both public and hidden checks. Agents made
  zero RepoMind MCP calls and left zero open sessions.
- The complete method, per-task results, provenance, report hashes, and limits
  are preserved in `docs/agent-run-acceptance-results-v0.9.md`.

## [0.8.0] - 2026-07-28

### Added

- `repomind eval --agent-profile` for offline attribution of Agent wall time,
  model turns, tokens, direct RepoMind MCP duration, and the model cycles around
  session start and commit calls from an existing report-v4 result.
- Reusable OpenCode host-lifecycle helpers for starting retrieval, injecting
  memory context, extracting Agent evidence, and committing a session outside
  the model loop.
- `repomind eval --agent --lifecycle host-managed` with sequential start,
  Agent, commit timing and report-v5 lifecycle telemetry. The existing
  `agent-managed` MCP workflow remains the default.

### Compatibility

- Agent report writers now emit schema v5. Aggregation and offline phase
  profiling continue to accept preserved schema-v4 reports.

### Validation

- The formal host-managed three-arm evaluation completed 72 isolated Agent
  runs across eight tasks and three repetitions with experiment integrity and
  every predeclared acceptance gate passing.
- RepoMind passed 24/24 hidden checks, matched full history on task quality,
  and reduced mean wall time by 12.711% and input tokens by 12.849% relative
  to full history in this controlled suite.
- The complete method, provenance, artifact hashes, paired intervals, and
  limitations are preserved in `docs/agent-benchmark-results-v0.8.md`.

## [0.7.1] - 2026-07-28

### Fixed

- Run controlled OpenCode Agent evaluations with `--pure` so global plugins do
  not inject untracked tools, MCP servers, or prompt behavior into any arm.

## [0.7.0] - 2026-07-28

### Added

- Manifest v2 three-arm Agent evaluation comparing no-memory, raw full-history,
  and RepoMind from independent clones of the same task commit.
- Latin-square arm ordering, full-history-specific acceptance gates, and report
  schema v4 with separate paired comparisons against both baselines.
- `repomind eval --agent-summary` for traceable multi-report aggregation with
  source SHA-256 hashes and approximate 95% paired-delta intervals.
- Four additional controlled tasks covering stale endpoints, error contracts,
  dependency boundaries, and changed configuration defaults.
- Cross-platform fixture validation for all eight deterministic task bases.

### Changed

- The shipped Agent suite is now manifest version 2 and requires raw history
  distinct from the evidence-backed memories supplied to RepoMind.
- CI validates public and hidden fixture baselines on Windows and Ubuntu.

### Compatibility

- Manifest version 1 remains supported and retains the v0.6 two-arm behavior.
- Report schema v4 replaces the v3 `paired` field with baseline-keyed
  `comparisons` and renames `noMemoryMean` to `baselineMean`.

## [0.6.0] - 2026-07-28

### Added

- Controlled `repomind eval --agent` OpenCode A/B evaluation with fresh clones,
  alternating arm order, external hidden checks, and isolated RepoMind data.
- Paired statistics and RepoMind win/tie/loss counts for task success, duration,
  token use, and file reads.
- Manifest-defined acceptance gates and `--require-acceptance` enforcement,
  kept separate from experiment-integrity validation.
- A reproducible four-task agent-suite generator with deterministic Git commits
  and actual base commits written into the generated manifest.
- Report provenance covering the RepoMind version and commit, Node and operating
  system, runner version, manifest SHA-256, and per-task base commits.
- A formal three-repeat v0.6 benchmark result document with methods, acceptance
  evidence, and explicit limitations.

### Changed

- Agent report schema version 3 adds provenance, including whether the tested
  RepoMind Git worktree contained uncommitted changes.

### Fixed

- Parse Git porcelain output without discarding the leading status character.
- Report a missing required task pair as failed acceptance instead of throwing.

## [0.5.0] - 2026-07-27

### Added

- Optional sqlite-vec retrieval with a versioned embedding cache, weighted
  lexical/vector rank fusion, automatic FTS5 fallback, and explicit vector
  reindexing.
- Embedding Provider interface, deterministic offline provider, and an
  OpenAI-compatible remote adapter configured through environment variables.
- Runnable `flat-vector-rag` and `repomind-layered-hybrid` comparison arms.
- The comparison benchmark now performs the requested `--repeat` count as
  independent latency samples while retaining one deterministic scoring cell
  per fixture, arm, placement, alpha, and budget.
- Conflict status details now list every known conflicting memory instead of
  only one. Existing v0.4 single-conflict status records remain readable and
  are normalized on access; no database migration is required.

### Fixed

- Embedding or sqlite-vec failures no longer block search or leave partial
  vector-cache writes.
- Reject comparison repeat counts outside the integer range 1 through 100.
- Report the number of latency samples so benchmark repetition is auditable.

## [0.4.0]

### Added

- **Secret redaction.** Evidence content, evidence metadata, session tasks,
  memory titles, content, tags, related file paths, governance reasons, and the
  forget tombstone all pass through deterministic redaction that leaves a
  visible `[REDACTED:kind]` marker. Git diff capture excludes sensitive paths
  (`.env*`, key material, `.npmrc`) at the pathspec level and records which
  files were excluded.
- **Forget.** `repomind forget` and `repo_memory_forget` physically delete a
  memory, its index entries, and by default any evidence no other memory
  references, recording only a content-free tombstone in `forget_log`. The CLI
  requires `--yes` after printing the deletion scope; the MCP tool requires
  `confirm: true`.
- **Conflict detection.** A new declarative memory that shares the type, scope,
  and title of a live memory but states different content is linked to it with
  a `contradicts` relation; both sides become `uncertain` with an explicit
  warning instead of silently coexisting. Session commits report a `conflicts`
  count.
- **Reactivation.** Recording a fact identical to a `superseded` or `invalid`
  memory revives that memory with a `memory_reactivated` audit entry instead of
  being silently discarded. Automatic extraction and correction deliberately do
  not reactivate.
- **`repo_memory_record` MCP tool**, so agents can store explicit repository
  facts without an LLM.
- **Retrieval benchmark.** `repomind eval --dataset <path>` seeds a fixed
  dataset into a throwaway repository and reports Recall@K, MRR, and search
  latency percentiles, including every missed query.
- **Cross-session scenario suite.** `repomind eval --scenarios` replays six
  end-to-end scenarios and reports the deterministic targets from the product
  spec: evidence binding, repository isolation, stale warnings, conflict
  surfacing, and commit idempotency.
- **Documentation.** `docs/benchmark.md`, ten architecture decision records
  under `docs/adr/`, and a CI workflow covering Windows and Ubuntu.

### Changed

- `CorrectMemoryResult` gained a `conflicts` field listing memories the
  replacement still contradicts.
- `record()` returns `reactivated` alongside `id`, `stored`, and `conflicts`.
- `CommitSessionResult.memories` gained a `conflicts` count.
- Correcting a memory no longer fails when the replacement is left `uncertain`
  by conflict detection; it fails only when the corrected content collides with
  a memory that is already `superseded` or `invalid`.

### Fixed

- Secrets stripped from evidence content survived verbatim in the same row's
  `metadata_json` and were returned by `repo_memory_inspect`.
- `correctMemory` always failed on conflicted memories, making the documented
  conflict-resolution workflow impossible.
- Every search re-read and re-hashed every related file of every memory. A
  staleness refresh now reads each file at most once and skips hashing when
  size and mtime are unchanged, while still re-hashing files touched inside the
  racy-mtime window.
- Fingerprint dedupe matched retired memories, so re-recording an explicit fact
  was a silent no-op with no recovery path.
- Benchmark recall could exceed 1.0 when seeded memories shared a title.
- The scenario suite leaked open SQLite handles when a scenario threw, turning
  cleanup into an unrelated `EBUSY` failure on Windows.

### Migrations

Schema versions 2 through 6 are applied automatically on open:

| Version | Change |
| --- | --- |
| 2 | `memories.status_reason_json` |
| 3 | `memory_relations` table |
| 4 | `forget_log` table |
| 5 | `memory_relations` rebuilt to allow the `contradicts` type |
| 6 | `memory_files.file_size` and `memory_files.file_mtime_ms` |

Migration 5 rebuilds `memory_relations` and copies existing rows; a test pins
that data preservation.

## [0.3.0]

### Added

- Memory governance: `validate`, `correct`, and `invalidate` transitions with
  audit history, `supersedes` relations, and persisted status reasons, exposed
  through both the CLI and MCP.
- `repomind commit --input <file|->` for passing a JSON result document, so
  PowerShell callers avoid shell quoting problems.
- Integration guides for MCP clients, OpenCode, stale detection, and governance.

## [0.2.0]

### Added

- File-hash stale detection that moves memories from `active` to `uncertain`
  with a concrete warning and expected/current hashes.

## [0.1.0]

### Added

- Repository identity (`.repomind/project.json`), SQLite/FTS5 storage with
  versioned migrations, read-only Git snapshots and bounded diff capture,
  session start/commit with idempotency receipts, deterministic memory
  extraction, search, inspection, and the first four MCP tools.
