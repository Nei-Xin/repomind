# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, minor releases may change behavior; every such change is listed
under **Changed** with its migration impact.

## [Unreleased]

### Added

- Opt-in AES-256-GCM encrypted logical exports and physical backup archives,
  with scrypt key derivation, authenticated versioned metadata, automatic
  import/restore detection, and full compatibility with existing plaintext
  formats.
- CLI `--encrypt` and `--passphrase-env` controls that accept archive
  passphrases only through the process environment, plus a rebuildable
  fixed-commit encrypted-portability acceptance and performance runner.

### Security

- Wrong passphrases, ciphertext/tag/AAD tampering, and archive-purpose mismatch
  are rejected before target data is written. Physical restore removes its
  temporary plaintext SQLite directory on every exit path, and CLI/report
  outputs exclude passphrase values.

### Validation

- The installed-tarball smoke suite now exercises both encrypted portability
  loops and credential exclusion in its Ubuntu, Windows, and macOS CI path.
- The remaining final-spec proof gate passed on the external MIT-licensed
  `sindresorhus/p-limit` repository. A Claude Code source task produced
  Evidence-backed Memory, and three paired fresh-context OpenCode comparisons
  preserved 100% public and hidden success while RepoMind reduced mean input
  Tokens by 41.1% and Agent duration by 17.5%. The report retains the original
  negative harness summary and the no-rerun correction for partial committed
  Sessions.

## [0.17.0] - 2026-07-29

### Added

- A rebuildable packaged-install acceptance runner that packs RepoMind, installs
  the tarball into an isolated consumer, and exercises CLI, MCP, backup, and
  restore through the installed artifact on every CI operating system.
- A versioned release-to-Schema manifest with immutable Migration hashes and
  upgrade fixtures covering every Schema shipped from v0.4.0 through v0.17.0.

### Fixed

- Database construction now closes its SQLite handle when setup or Migration
  fails, allowing operators to move, replace, or recover the rejected file.

### Documentation

- Reconciled the final-product checklist with implementation and formal
  evidence, leaving the external real-open-source cross-session case as the
  remaining v1.0 proof gate.

### Validation

- All 169 tests across 38 files pass. Source coverage is 83.82% statements and
  lines, 77.54% branches, and 95.04% functions.
- The local packaged-install acceptance passed all 11 gates through the npm
  tarball, including CLI persistence, MCP Start/Search/Inspect/Abandon, and
  checksummed backup/restore.
- GitHub Actions run `30444019485` passed Ubuntu, Windows, macOS, coverage, and
  comparison jobs against clean commit `432f4f6`. Every verify job ran the new
  installed-tarball acceptance after all 169 tests and fixture validation.

## [0.16.0] - 2026-07-29

### Added

- An injectable LLM Runner boundary and an opt-in OpenAI-compatible structured-
  output adapter configured independently through `REPOMIND_EXTRACTION_*`.
- Explicit `repomind extract` and `repo_memory_extract` entry points for
  completed Sessions, plus provider/model/usage/timing result metadata.
- Fixed-fixture tests for valid and empty batches, malformed output, fabricated
  Evidence, all-or-nothing validation, deduplication, prompt injection,
  cancellation, provider configuration, and HTTP adapter behavior.
- A rebuildable nine-scenario remote-extraction acceptance runner with mock and
  live modes, fixed-commit provenance, quality/Evidence/audit gates, latency and
  token measurements, atomic-failure probes, and credential-safe JSON/Markdown
  reports.

### Security

- Remote candidates pass strict Zod validation plus deterministic Evidence,
  scope, confidence, size, and repository-path checks before any write begins.
  Accepted batches use one transaction and every memory binds existing Session
  Evidence; any invalid candidate or remote failure produces zero partial
  writes.
- Memory audit provenance records remote mode, provider, model, and source
  Session; deduplicated candidates are audited when they add new Evidence.
- Remote extraction is disabled by default, uses already-redacted and bounded
  Session Evidence, and never runs implicitly during Session Start or Commit.

### Fixed

- Remote candidates with the same title/scope and conservatively equivalent
  content now deduplicate across model type and wording drift. Numeric changes
  or opposite negation remain distinct so contradictory facts are not silently
  merged.

### Validation

- The release regression and coverage suites pass 167 tests across 38 files.
  Source coverage is 83.81% statements and lines, 77.52% branches, and 95.04%
  functions; the remote-extraction implementation has 96.00% line/statement,
  79.06% branch, and 100% function coverage.
- The clean-commit live `gpt-5.6-terra` run passed all 13 remote-extraction
  gates across nine scenarios: recall, precision, empty/injection behavior,
  Evidence and Audit binding, deduplication, atomic failures, latency, token
  reporting, worktree provenance, and SQLite health all passed.
- Recall, precision, empty accuracy, Evidence binding, and Audit binding were
  all 1.000. P50/P95 remote latency was 9.565/12.669 seconds and the provider
  reported 7,584 input plus 1,083 output tokens.
- A real Claude Code to OpenCode continuous task passed all 17 cross-Agent
  gates. Claude created and committed the source Session through MCP, explicitly
  extracted and inspected the remote memory, and OpenCode retrieved that Memory
  first through the Host-managed daily entry point before applying the retained
  `${warehouseId}:${requestId}` convention. All nine target tests and the
  external hidden check passed with zero open Sessions or running Host Runs.
- GitHub Actions run `30436034305` passed Ubuntu, Windows, macOS, coverage, and
  comparison jobs on the first attempt against evidence commit `37718df`.

## [0.15.0] - 2026-07-29

### Added

- Deterministic L4 Skill Candidate generation from at least three independent
  committed Sessions with matching successful command and test workflows.
- Repository-scoped candidate inspection with Session, Evidence, and audit
  provenance; explicit approve/reject review; and safe `SKILL.md` export.
- CLI and MCP entry points for candidate rebuild, list, inspect, review, and
  export. RepoMind never installs or executes exported candidates.
- A rebuildable fixed-commit L4 acceptance runner covering thresholds,
  unsuccessful Session exclusion, provenance, review, safe export, approval
  invalidation, repository isolation, logical recovery, and operation latency.

### Changed

- Logical repository export format v2 now includes L4 candidates and their
  provenance while retaining read compatibility with v1 exports.
- Candidate source changes reset prior approval to `pending`. Export refuses
  unapproved candidates and existing files, redacts secrets and absolute
  paths, and records a checksummed audit event.

### Fixed

- L4 audit inspection and logical export preserve event insertion order when
  multiple lifecycle actions share the same millisecond timestamp, instead of
  using random audit UUIDs as the tie-breaker.
- Vitest allows 30 seconds for regular tests and hooks so SQLite migrations and
  child-process tests remain deterministic on intermittently slow Windows CI
  runners without changing product performance gates.

### Validation

- The release regression and coverage suites pass 153 tests across 34
  files. Coverage remains above every project floor at 83.48% statements and
  lines, 77.55% branches, and 94.82% functions; L4 candidate code has 95.96%
  line, 82.70% branch, and 100% function coverage.
- The clean-commit L4 acceptance passed all 20 gates with four
  successful source Sessions, four excluded Sessions, and 28 Evidence links.
  On final release-closure commit `e9b1caf`, candidate rebuild/list/inspect P95
  was 0.596/0.115/0.201 ms over 20 samples.
- A real OpenCode-to-Claude Code run passed all 17 lifecycle checks: OpenCode
  produced repeated Host-managed sources, Claude reviewed and exported the
  candidate through MCP, and a later matching source reset approval to
  `pending` with complete provenance and audit history.
- GitHub Actions run `30424663099` passed Ubuntu, Windows, macOS, coverage, and
  comparison jobs on the first attempt after fixing same-millisecond L4 audit
  ordering and increasing test-runner allowances for slow hosted Windows I/O.

## [0.14.0] - 2026-07-29

### Added

- A rebuildable fixed-commit 10,000-L1 scale acceptance runner with hard gates
  for FTS, cached hybrid retrieval, Memory Inspect, Session Start, CLI cold
  start, Evidence coverage, repository isolation, and SQLite integrity.

### Changed

- Repository-wide stale checks now validate each distinct file fingerprint
  before materializing memory-file rows, avoiding repeated work when thousands
  of memories refer to the same unchanged files.
- Lexical search skips a redundant full-table substring scan when a multi-term
  non-ideographic FTS query has already proved that no exact substring can
  match. CJK and single-token substring recall remain available.
- Scale-runner smoke mode enforces portable integrity, recall, isolation,
  database, and Session checks while recording, but not gating on,
  machine-dependent latency. Formal 10,000-L1 mode retains all six performance
  gates unchanged.

### Validation

- The clean-commit formal run at `01d79f2` passed all 19 gates with exactly
  10,000 active, Evidence-backed, file-linked, audited, FTS-indexed, and
  vector-indexed L1 memories.
- Measured P95 latency was 80.363 ms for FTS hits, 76.431 ms for empty FTS
  results, 302.774 ms for cached hybrid search, 0.891 ms for Memory Inspect,
  621.154 ms for Session Start, and 374.829 ms for CLI cold start.
- The regression suite passes 148 tests across 32 files, and the rebuildable
  eight-task Agent fixture suite remains valid.
- GitHub Actions run `30376367751` passed Ubuntu, Windows, macOS, coverage, and
  comparison jobs on the formally accepted commit. Run `30376863051` also
  passed all five jobs after the evidence-only documentation commit.

## [0.13.0] - 2026-07-28

### Added

- Versioned logical repository exports with deterministic SHA-256 checksums,
  fixed table and column contracts, repository-level counts, and sensitive
  value scanning before data leaves local storage.
- Atomic cross-project logical import in explicit `replace` mode. Project and
  checkout references are mapped to the initialized target repository,
  machine-local and derived indexes are excluded, and FTS is rebuilt inside
  the same transaction.
- Consistent SQLite backups with a versioned checksum manifest, plus same-
  project restore that validates integrity and schema, retains a pre-restore
  snapshot, and rolls back the live database if replacement validation fails.
- CLI commands `export`, `import`, `backup`, and `restore`, including dry-run,
  explicit confirmation, no-overwrite, and active-session guards.
- A rebuildable fixed-commit real-repository recovery drill covering logical
  migration, physical recovery, corruption rejection, unreadable-database
  approval, retained rollback snapshots, and P50/P95 operation latency.
- V8 coverage reporting with enforceable aggregate floors and downloadable CI
  artifacts. The main verification matrix now includes macOS.

### Changed

- `repomind status` now reports the supported logical export, import, backup,
  and restore contracts under `capabilities.portability`.

### Validation

- Direct portability tests cover cross-project replacement, checksum
  tampering, transaction rollback on relational failure, sensitive export
  blocking, physical restore, retained rollback snapshots, and rejected
  corrupt backups. A separate cross-process CLI test exercises all four public
  commands.
- The development baseline passes 144 tests across 31 files, and the
  rebuildable eight-task Agent fixture suite remains valid.
- The real-repository recovery drill passed at commit `97f9816` with 15 L1
  memories, 15 Evidence records, 10 L2 narratives, and one L3 profile. The
  slowest measured P95 was 94.046 ms for confirmed physical restore on the
  recorded Windows host.
- The source-only V8 baseline is 83.00% statements/lines, 77.14% branches, and
  94.33% functions; enforced floors are 80%, 75%, 90%, and 80% respectively.
- GitHub Actions run `30358584725` passed Ubuntu, Windows, macOS, coverage, and
  comparison jobs at commit `fd8093c`; macOS completed the full verification
  suite in 1 minute 24 seconds.
- Real Claude Code 2.1.220 processes connected through isolated MCP
  configuration, recalled and inspected memories created by prior OpenCode
  runs, created and reloaded an L3 profile, and closed their RepoMind Session.
  Final verification found no open Sessions and no target worktree changes.

## [0.12.0] - 2026-07-28

### Added

- Independent L2 Module Narratives derived only from active, evidence-backed
  L1 memories, with module-scoped incremental rebuilds, bounded content,
  source fingerprints, L1/Evidence provenance inspection, FTS retrieval, and
  optional Session Start context.
- CLI commands `module-rebuild`, `modules`, and `module-inspect`, plus MCP tools
  `repo_module_rebuild`, `repo_module_list`, and `repo_module_inspect`.
- Migration 9 adds the L2 source-of-truth, source-link, and derived FTS tables.
- A rebuildable fixed-commit real-repository L2 acceptance runner records
  functional integrity and P50/P95 latency without using daily RepoMind data.
- A versioned, bounded L3 Repository Profile derived from stable,
  evidence-backed repository L1 facts and L2 module boundaries. It preserves
  L1/L2 provenance and every profile version, ignores low-confidence source
  changes, and injects only a current profile into Session Start.
- CLI commands `profile-rebuild`, `profile`, and `profile-inspect`, plus MCP
  tools `repo_profile_rebuild`, `repo_profile_get`, and
  `repo_profile_inspect`. Session Start supports explicit profile opt-out.
- Migration 10 adds the L3 profile, live source-link, and version-history
  tables.
- A rebuildable fixed-commit L3 acceptance runner verifies provenance,
  confidence isolation, freshness, versioning, Session Start injection, and
  P50/P95 latency on the real RepoMind repository.

### Changed

- `repomind reindex` now rebuilds both L1 and L2 FTS indexes.
- Manual CLI recording accepts module/path scope and related files, allowing
  explicit L1 facts to participate in deterministic L2 derivation.

### Validation

- The development baseline passes 137 tests across 29 files, including L2/L3
  provenance, bounded rendering, incremental freshness, FTS recovery,
  cross-process CLI, MCP stdio purity, and upgrades from every prior Schema.
- Real-repository L3 acceptance passed all 15 integrity and latency gates at
  commit `051212d`; unchanged rebuild, get, and inspect P95 remained below
  6 ms, and Session Start P95 was 210.615 ms on the recorded Windows host.

## [0.11.0] - 2026-07-28

### Added

- `repomind review` provides a repository maintenance queue for uncertain
  memories, classified as stale-file, conflict, or other review work. Each
  item includes its concrete reason, evidence count, related files, and
  suggested inspect, validate, correct, and invalidate commands.
- `repomind review-apply --input <json|->` atomically applies an approved batch
  of validation and invalidation decisions, while `repomind review-history`
  exposes the existing audit trail as an operational maintenance log.
- MCP clients can list and apply review work through `repo_memory_review` and
  `repo_memory_review_apply`. The missing `repo_session_abandon` lifecycle tool
  is now available to non-host-managed MCP clients.

### Changed

- Nested database operations use SQLite savepoints, allowing an entire review
  batch to commit or roll back as one unit.

## [0.10.0] - 2026-07-28

### Added

- Persistent Host-managed run history backed by the repository database, with
  `repomind runs` filtering and `repomind run-inspect` details for successful,
  failed, interrupted, and output-setup-failed daily runs. Run reports retain
  the retrieved memory IDs so cross-task reuse is auditable.
- Review-first cold-start commands: `repomind bootstrap` creates deterministic,
  redacted candidates from repository documentation and recent Git history;
  `repomind bootstrap-apply --yes` validates and stores all or selected
  candidates.
- A continuous daily-workflow test proving that a cold repository can be
  bootstrapped and that a second Host-managed task receives memory produced by
  the first task.

### Security

- Bootstrap application verifies project identity and source hashes, rejects
  outside-repository paths and unknown candidate IDs, and never persists
  candidates without explicit confirmation.

### Validation

- The formal continuous-workflow acceptance passed with selective cold-start
  bootstrap, two successful real OpenCode tasks, verified reuse of task 1
  memory by task 2, persistent history for all runs, and clean timeout
  abandonment with zero open sessions or running Host runs.
- The method, provenance, artifact hashes, final-state audit, and limitations
  are preserved in `docs/daily-workflow-acceptance-results-v0.10.md`.

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
