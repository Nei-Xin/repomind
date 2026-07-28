# L2 Module Narratives

RepoMind v0.12 development adds a real derived memory layer above atomic L1
memories. L2 is stored independently; a module-scoped L1 memory is not relabeled
or treated as a narrative.

## Source eligibility

A memory can contribute only when it is:

- in the same repository;
- `active` rather than uncertain, superseded, or invalid;
- linked to at least one Evidence row; and
- assigned to a module explicitly or linked to a file whose parent directory
  identifies the module.

An explicit `module` scope wins over file-derived modules. Otherwise, one L1
memory may support multiple modules when its Evidence-related files cross
module boundaries.

## Rebuild

```bash
repomind module-rebuild --json
repomind module-rebuild --module src/storage,src/mcp --budget 4000 --json
```

The default budget is 4,000 characters. Accepted values are 500 through
20,000. Content is grouped into key files, responsibilities and boundaries,
technical decisions, failures and verification, and current risks. Every
conclusion includes its source Memory ID.

RepoMind hashes the ordered source IDs, L1 fingerprints, update/validation
times, and Evidence counts. A matching fingerprint and budget produces an
`unchanged` result. A changed module increments its L2 version. A requested
module with no eligible source deletes its derived narrative.

## Freshness and provenance

```bash
repomind modules --json
repomind module-inspect l2_... --json
```

`modules` recomputes source fingerprints and reports `current: false` before a
stale narrative can be injected into Session Start. `module-inspect` returns
the contributing L1 Memory IDs, types, titles, confidence, related files, and
Evidence IDs. This provides the trace:

```text
L2 conclusion -> L1 memory -> Evidence
```

Search uses a separate L2 FTS index. `repomind reindex` reconstructs both L1
and L2 indexes from their SQLite source tables.

## MCP and task start

MCP clients use `repo_module_rebuild`, `repo_module_list`, and
`repo_module_inspect`. `repo_session_start` also returns up to two current L2
narratives matching the task. Stale narratives remain inspectable but are not
returned as task context.

## Current boundary

This first L2 implementation is deterministic. It does not infer undocumented
module history, use a remote LLM, or replace L1 retrieval. L3 Repository
Profiles and L4 Skill Candidates remain separate future layers.
