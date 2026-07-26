# ADR-005: Memory and Evidence are stored separately

Status: accepted

## Context

A memory is a reusable conclusion; evidence is the raw material that justifies it. Conflating them makes conclusions unauditable and forces large diffs into every recall.

## Decision

`memories` and `evidence` are separate tables joined by `memory_evidence`. Every automatically extracted memory must reference at least one evidence row. Recall returns memory bodies only; evidence is fetched on demand through inspect.

## Consequences

- `repo_memory_inspect` can always answer "why does this memory exist".
- Evidence is immutable once referenced; corrections create new records instead of editing history.
- Forgetting must resolve shared references: evidence used by other memories survives, orphaned evidence can be physically deleted (see `forget_log`).
