# RepoMind v0.15 L4 Skill Candidate acceptance

## Goal

The acceptance runner verifies the complete L4 boundary: repeated successful
repository workflows become evidence-backed candidates, humans control review,
and only approved candidates can be exported for external inspection. RepoMind
does not install or execute exported Skills.

## Run

Use a new workspace for every run. The runner refuses to overwrite an existing
path and keeps all RepoMind state under that workspace.

```powershell
npm run bench:l4-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v0.15-l4-<new-id> `
  --commit <full-commit> `
  --repeat 20
```

The workspace receives `l4-skill-candidate-report.json`, a readable Markdown
report, the approved `SKILL.md`, and a logical repository export.

## Hard gates

The run fails unless all of these boundaries hold:

- two matching successful Sessions produce no candidate and three produce one;
- partial, failed, abandoned, and command-free Sessions do not qualify;
- every candidate traces to its Session and Evidence sources;
- export is blocked until explicit approval;
- review and export are audited, and exported content contains no supplied
  secret or absolute path;
- a fourth matching source invalidates prior approval;
- Project IDs remain isolated before an explicit logical import;
- logical import preserves the candidate ID, state, Sessions, and Evidence;
- SQLite integrity, foreign keys, and closed-Session invariants pass; and
- candidate rebuild, list, and inspect P95 remain below two seconds on the
  measured machine.

## Interpretation

This is a deterministic, fixed-commit product acceptance. It uses the same
public Session, candidate, review, export, and portability APIs as an Agent
workflow, but it does not substitute for a later live second-Agent usability
run. Exact normalized successful command and test signatures deliberately
favor candidate precision over fuzzy recall.

## Development evidence

The initial Windows development run on 2026-07-29 passed all 20 gates with
four successful source Sessions, four deliberately excluded Sessions, one
candidate, and 28 retained Evidence links. Across 20 samples, P95 latency was
0.780 ms for rebuild, 0.093 ms for list, and 0.300 ms for inspect.

Artifacts are retained at:

```text
D:\data\code\project\repomind-test\v0.15-l4-20260729-02
```

The JSON report SHA-256 is
`b5233d7944be2120247f4422e1854deb42af68f38d34262c16af3d00117a0043`;
the Markdown report SHA-256 is
`6fb0aabd0b4a628ebfe5cc1d1f0c823b3bc4de694dc548a2d76453cd7bd0e48f`.

This run targeted `efd984fcc6db826708fb67ee49fe3eb07ebc130e`, but the report
correctly records `sourceWorktreeDirty: true`: the v0.15 implementation and
runner were not committed yet. It is development evidence, not the clean-
commit release evidence required before v0.15.0.
