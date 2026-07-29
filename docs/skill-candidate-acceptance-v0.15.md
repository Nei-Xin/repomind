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
workflow. The separate live OpenCode/Claude acceptance covers real cross-Agent
use without changing these deterministic gates. Exact normalized successful
command and test signatures deliberately favor candidate precision over fuzzy
recall.

## Formal release evidence

The clean-commit Windows run on 2026-07-29 passed all 20 gates with four
successful source Sessions, four deliberately excluded Sessions, one
candidate, and 28 retained Evidence links. The runner and target checkout were
fixed at commit `a45a356125fdd1bb36570b7058d9eca76eccd2db`; the report records
`sourceWorktreeDirty: false`.

Artifacts are retained at:

```text
D:\data\code\project\repomind-test\v0.15-l4-20260729-03
```

The JSON report SHA-256 is
`51ae9eebd16ad293b14a3517ba2cb0c20d127c4853d95299a41e1dcc21aaf843`;
the Markdown report SHA-256 is
`bea5d008cd2680ff67974ca667a3daec8b71194cc0cf86c64601810939ed3743`.

| Operation | Samples | P50 ms | P95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Candidate rebuild | 20 | 0.478 | 0.585 | 1.061 |
| Candidate list | 20 | 0.030 | 0.113 | 0.137 |
| Candidate inspect | 20 | 0.200 | 0.332 | 0.367 |

This deterministic run proves the L4 product boundary and measured local
latency. The separate
[`l4-cross-agent-acceptance-v0.15.md`](l4-cross-agent-acceptance-v0.15.md)
records the real OpenCode/Claude lifecycle and cross-platform CI evidence.
