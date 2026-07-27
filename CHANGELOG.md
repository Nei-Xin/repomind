# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, minor releases may change behavior; every such change is listed
under **Changed** with its migration impact.

## [Unreleased]

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
