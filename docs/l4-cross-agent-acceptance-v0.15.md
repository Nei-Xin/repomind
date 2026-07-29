# RepoMind v0.15 real cross-Agent acceptance

## Result

The formal run on 2026-07-29 passed all 17 checks against RepoMind commit
`a45a356125fdd1bb36570b7058d9eca76eccd2db`. OpenCode created repeated real
Host-managed task evidence, and Claude Code independently used the RepoMind
MCP interface to rebuild, inspect, approve, export, and later refresh the same
L4 candidate. No global OpenCode or Claude configuration was changed.

Artifacts are retained outside the repository at:

```text
D:\data\code\project\repomind-test\v0.15-cross-agent-20260729-01
```

The JSON report SHA-256 is
`25aa967f499019b273b47aa8fb26a3792bcf9f913b5674a7546287d72969ca3b`;
the Markdown report SHA-256 is
`2988ef047fb772d422aedcf77fc0793729b3e6f824b5209ec87f287a5c6baaf6`.

## Agents and lifecycle

OpenCode 1.18.7 used `cliproxyapi/gpt-5.6-terra` for five successful real
Host-managed repository tasks. All five edited source or tests, passed the
target repository test suite, and committed their RepoMind Session. Memory
retrieval counts grew from 0 on the first task to 2, 4, 5, and 5. The Agent
made zero direct RepoMind calls because the host owned the lifecycle. OpenCode
used 28,869 input and 3,960 output tokens.

Claude Code 2.1.220 connected through an isolated MCP configuration and used
its configured primary model, `gpt-5.6-luna`. Two Claude Sessions rebuilt and
inspected the candidate, approved and exported it, and then rebuilt it after a
new matching OpenCode source arrived. This proves cross-Agent operation; the
different configured models mean it is not a model-quality comparison.

| Stage | Status | Source Sessions | Evidence links |
| --- | --- | ---: | ---: |
| Generated after three matching OpenCode runs | `pending` | 3 | 18 |
| Reviewed and exported through Claude MCP | `approved` | 3 | 18 |
| Rebuilt after a new matching OpenCode source | `pending` | 4 | 24 |

Candidate ID:
`l4_8afaea82-2a12-48b2-9dcf-6db8e51f57b0`

Audit sequence:
`generated -> approved -> exported -> sources_changed`

Export SHA-256:
`b9927e8779be8a5e0ad45c4b50bdba770b6a17ea1f5760c52374d41ac4a721db`

The final target state contained six Sessions, five committed and one safely
abandoned after an initial Windows `.cmd` launcher `spawn EINVAL` failure. It
also contained 33 Evidence records, ten L1 memories, one L4 candidate, zero
open Sessions, and zero running Host Runs. All six target repository tests
passed. The exported Skill contained no credentials or Windows/Unix absolute
paths.

## Cross-platform CI

[GitHub Actions CI #57](https://github.com/Nei-Xin/repomind/actions/runs/30421126920)
completed successfully for the same implementation commit. Ubuntu, macOS,
coverage, comparison benchmark, and Windows jobs passed. The final workflow
attempt completed in 6 minutes 48 seconds.

The first Windows attempt had dispersed test and hook timeouts with no
assertion failure. Only the failed Windows job was rerun; it passed in 6
minutes 44 seconds. The retry is part of the formal evidence and is not
represented as a first-attempt pass.

Coverage artifact SHA-256:
`37ee909043b8f6f2dc5e0625018670e467b489e63f01f0c7a804c9c77bf10776`

Comparison artifact SHA-256:
`9c187d00ae570a2a651567a89e29fb6ee2fb2fba442ee99317769abbc093e1b0`

The local release baseline passed 153 tests across 34 files. Source coverage
was 83.48% statements/lines, 77.55% branches, and 94.82% functions. The L4
candidate implementation reached 95.96% lines, 82.70% branches, and 100%
functions.

## Interpretation and limits

- This is interoperability and lifecycle evidence, not a comparison of Agent
  or model quality.
- The target is a controlled real-Agent repository fixture, not a broad sample
  of production repositories.
- Exact command-set grouping intentionally excludes semantically similar
  workflows when their successful commands differ. One successful OpenCode
  run that also executed `git status` and `git diff` was therefore excluded
  from this candidate.
- RepoMind exports a reviewable `SKILL.md`; it never installs, registers, or
  executes the Skill.
- The initial launcher failure and the Windows CI retry remain visible parts
  of the evidence.
