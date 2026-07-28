# L3 Repository Profile

RepoMind v0.12 development adds a repository-level profile above atomic L1
memories and L2 module narratives. L3 is an independent, versioned derived
record. It is not an L1 memory relabeled as a summary and it does not replace
task-specific L1/L2 retrieval.

## Source eligibility

Repository facts can contribute when they are active, repository-scoped,
evidence-backed, one of the stable fact types, and at or above the configured
confidence threshold. Stable fact types are architecture, convention,
decision, command, dependency, requirement, and risk.

L2 contributes module boundaries. RepoMind projects each narrative back onto
its active, evidence-backed L1 sources and applies the L3 confidence threshold
again. The L3 fingerprint therefore ignores a low-confidence L1 even if that
source caused an L2 narrative version to change.

## Rebuild and inspect

```bash
repomind profile-rebuild --json
repomind profile-rebuild --budget 6000 --min-confidence 0.8 --json
repomind profile --json
repomind profile-inspect --json
```

The default budget is 6,000 characters and the accepted range is 1,000 through
30,000. The default minimum confidence is 0.8 and the accepted range is 0.5
through 1. A rebuild with the same eligible source fingerprint, budget, and
confidence threshold is unchanged. A changed fingerprint increments the
version. Every version retains its rendered content and source IDs.

`profile-inspect` exposes the current live L1 and L2 source links, Evidence IDs,
and all retained profile versions. This provides both supported traces:

```text
L3 conclusion -> repository L1 memory -> Evidence
L3 module boundary -> L2 narrative -> module L1 memory -> Evidence
```

## Freshness and task start

`profile` recomputes the eligible source fingerprint. When a qualifying source
changes, the existing profile reports `current: false`. It remains available
for inspection and rebuild, but Session Start does not inject it until it has
been rebuilt.

CLI task start includes a current profile by default. Use `start --no-profile`
to disable it. MCP clients receive the same behavior through
`repo_session_start`; set `include_repository_profile` to `false` to opt out.
The L3-specific MCP tools are `repo_profile_rebuild`, `repo_profile_get`, and
`repo_profile_inspect`.

## Current boundary

This implementation is deterministic and local. It does not claim remote LLM
extraction quality, 10,000-L1 scale, cross-Agent interoperability on a second
real client, export/import or backup/restore, macOS compatibility, coverage
proof, or L4 Skill Candidate generation. Those remain explicit release goals.
