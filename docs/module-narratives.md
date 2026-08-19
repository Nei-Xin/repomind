# L2 Module Narratives

RepoMind v0.12 development adds a real derived memory layer above atomic L1
memories. L2 is stored independently; a module-scoped L1 memory is not relabeled
or treated as a narrative.

## Source eligibility

A memory can contribute when it is:

- in the same repository;
- `active`, or a previously contributing memory that became `uncertain` only
  because one of its related files changed;
- linked to at least one Evidence row; and
- assigned to a module explicitly or linked to a file whose parent directory
  identifies the module.

Previously contributing stale-file memories are carried forward with an
explicit `stale: verify against current files` marker. A conflict-uncertain,
superseded, or invalid memory is never carried forward. Exact duplicate facts
are collapsed by type and normalized content, preferring an active and then
newer source. This lets additive tasks retain earlier module knowledge without
silently treating stale provenance as current truth. Invalidating or
superseding a source removes its content on the next rebuild.

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

RepoMind hashes the ordered source IDs, L1 fingerprints, and source status.
Evidence-link additions and validation timestamps alone do not change the
derived version. A matching fingerprint and budget produces an
`unchanged` result. A changed module increments its L2 version. A requested
module with no eligible source deletes its derived narrative.

After a successful `repomind run` Host commit, RepoMind synchronously invokes
the same default rebuild as best-effort derived maintenance. A run with no
eligible L1 source and no existing narrative to maintain reports L2 as skipped.
An L2 maintenance error is reported separately and cannot roll back the
committed Session or change Host-run success. Partial, failed, and abandoned
runs do not rebuild L2 automatically.

The automatic path is Host-managed only. `module-rebuild` and
`repo_module_rebuild` remain available, and agent-managed sessions, direct CLI
commits, MCP commits, and direct Core commits must invoke one of them explicitly
when they need fresh L2 records.

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

`repomind run` combines relevant current narratives with current L3 and ranked
L1 under its repository context budget. The complete current task and fixed
Host lifecycle instructions are outside that budget.

## Current boundary

This first L2 implementation is deterministic. It does not infer undocumented
module history, use a remote LLM, or replace L1 retrieval. L3 Repository
Profiles consume its module boundaries through a separate confidence-filtered
projection; L4 Skill Candidates are maintained through their own
review-required workflow.
