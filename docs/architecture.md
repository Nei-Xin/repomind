# Architecture

RepoMind turns coding sessions into repository knowledge that survives the
session that produced it. This document explains how the pieces fit; the
reasoning behind each structural choice lives in [`adr/`](adr/).

## Layers

```text
MCP server  |  CLI  |  eval runners
                 |
       RepositoryMemoryCore
                 |
  storage (SQLite)  git (read-only)  security (redaction)
```

Dependencies point downward only. The core imports no MCP SDK, so the CLI,
tests, and benchmark runners drive the same code an agent drives
([ADR-008](adr/ADR-008-core-independent-of-mcp-sdk.md)). The MCP layer parses
parameters, calls the core, maps errors to stable codes, and truncates output;
it holds no business rules of its own, which is why CLI and MCP semantics
cannot drift apart.

## Identity and data location

`repomind init` writes `.repomind/project.json` into the repository — a stable
UUID and a name, safe to commit. Everything else lives in
`~/.repomind/repositories/<projectId>/repomind.db`, overridable with
`REPOMIND_DATA_DIR`. Two checkouts of the same project therefore share one
memory database, and no execution trace can be committed by accident
([ADR-007](adr/ADR-007-marker-in-repo-data-in-home.md)).

Every query and write carries the repository ID. Isolation is not a filter
applied at the edges; it is a column in every statement, and a benchmark
scenario asserts that no query crosses repositories.

## The session protocol

An MCP server sees only calls made to its own tools. It cannot observe the host
agent's file edits, shell commands, or test runs, so RepoMind cannot passively
record what an agent did ([ADR-002](adr/ADR-002-mcp-first-protocol.md)). It
uses an explicit protocol instead:

```text
repo_session_start   capture Git baseline, recall relevant memories
   (agent works normally, using its own tools)
repo_session_commit  submit results; RepoMind re-reads Git and diffs
```

The agent's summary is a claim; the Git baseline, final state, bounded diff,
and test exit codes are evidence gathered independently. That asymmetry is the
point: conclusions are only as trustworthy as what backs them.

Commits carry an idempotency key. A repeated commit returns the original
receipt and writes nothing new, so a client retry cannot duplicate knowledge.

## Memory and evidence

Memories and evidence are separate tables joined by `memory_evidence`
([ADR-005](adr/ADR-005-memory-evidence-separation.md)). Every automatically
extracted memory binds to at least one evidence row, which is what lets
`repo_memory_inspect` answer "why does this memory exist" instead of asking the
user to trust a summary. Recall returns memory bodies only; evidence is fetched
on demand so a large diff never lands in an agent's context by default.

Extraction is deterministic today: decisions become `decision` memories,
passing test commands become verified `command` memories, and a successful
summary becomes a `solution` memory. No model output reaches the database. When
an LLM extractor lands it must pass schema validation and evidence binding
first ([ADR-009](adr/ADR-009-validated-output-before-persistence.md)).

## Lifecycle

```text
active ──▶ uncertain ──▶ active        validate
active/uncertain ──▶ superseded        correct
active/uncertain ──▶ invalid           invalidate
any ──▶ (deleted, tombstone kept)      forget
```

Memories change state on signals, never on a clock
([ADR-006](adr/ADR-006-status-transitions-not-time-decay.md)). Two signals
drive it:

**File change.** Each memory records the hash of its related files. Search and
inspect refresh that state lazily: a file whose size and mtime are unchanged is
not re-hashed at all, each file is read at most once per refresh, and files
touched inside a two-second window are always re-hashed because an edit landing
in the same filesystem tick can leave size and mtime identical. A changed or
deleted file moves the memory to `uncertain` with a concrete warning — needs
review, not necessarily wrong.

**Contradiction.** A new declarative memory sharing another's type, scope, and
title but stating different content is linked with a `contradicts` relation and
both sides become `uncertain`. Conflicting facts are never silently merged.
Episodic types (`command`, `failure`, `solution`) are exempt: repeating them
with different outcomes is history, not contradiction.

Only `forget` deletes. It removes the memory, its index entries, and any
evidence no other memory references, leaving a content-free tombstone in
`forget_log` so the deletion itself stays auditable.

## Retrieval

Search is FTS5 over title, content, tags, and related files, with
identifier-aware tokenization (camelCase, snake_case, and paths are split into
extra search terms) and a substring fallback when FTS returns too little. It is
always scoped to one repository and filtered by status; `superseded` and
`invalid` memories never enter an agent's context, and `uncertain` results
carry their warning.

Vector retrieval is deliberately absent
([ADR-004](adr/ADR-004-fts5-before-vectors.md)). Most repository queries —
commands, file paths, identifiers, error strings — match well lexically, and
`repomind eval` exists to measure whether embeddings would actually beat that
baseline before taking on the dependency.

## Storage

SQLite is the source of truth ([ADR-003](adr/ADR-003-sqlite-source-of-truth.md)):
WAL enabled, foreign keys on, one connection per process, versioned migrations
applied on open. FTS is a derived index that can be rebuilt. Every multi-table
write runs in one transaction, so a failed extraction leaves no half-written
memory.

## Security posture

Repository text is data, never instructions. Only predefined read-only Git
commands run, with timeouts and output caps
([ADR-010](adr/ADR-010-read-only-git-commands.md)). Paths are resolved and
rejected if they leave the repository root. Everything reaching storage passes
through redaction, and diff capture excludes sensitive paths at the pathspec
level. See [`../SECURITY.md`](../SECURITY.md) for the threat model and the
limits of pattern-based redaction.
