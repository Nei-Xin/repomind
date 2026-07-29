# RepoMind v0.17 external open-source cross-session benefit acceptance

## Outcome

The formal acceptance passed on 2026-07-29. A Claude Code task on the real
`sindresorhus/p-limit` repository produced Evidence-backed RepoMind memories.
Six later OpenCode sessions started from the same post-task commit and compared
three no-memory runs with three RepoMind runs. Both arms passed every public and
external hidden check. RepoMind reduced mean input Tokens by 41.1% and mean
Agent duration by 17.5%, with improvement in all three paired repetitions.

This closes the external real-open-source cross-session proof criterion from
the final product specification. It proves a bounded benefit case; it does not
claim that every repository task will be faster or use fewer Tokens.

## External repository and fixed state

| Field | Value |
| --- | --- |
| Upstream | `https://github.com/sindresorhus/p-limit.git` |
| Upstream tag | `v7.3.1` |
| Upstream commit | `df476048d023ff868cd45b35ee47f5fb0ca2b25a` |
| License | MIT |
| License SHA-256 | `5c932d88256b4ab958f64a856fa48e8bd1f55bc1d96b8149c65689e0c61789d3` |
| Shared post-Task-1 commit | `a8d74fe28f000ec4f323e43c10863b0d47c7d8b3` |
| RepoMind | `0.17.0` / `6961a65ed0e96c90fc3041811da4b5ceb7f5d8e2` |
| Task 1 Agent | Claude Code `2.1.220` / `gpt-5.6-luna` |
| Task 2 Agent | OpenCode `1.18.7` / `cliproxyapi/gpt-5.6-terra` |
| Host | Windows x64 / Node.js `v22.20.0` |

The retained workspace is outside the product repository:

```text
D:\data\code\project\repomind-test\v017-external-cross-session-20260729-01
```

The protocol was registered before either task ran. Its SHA-256 is
`df1d481f6917a33a14b5c3e7254a8976a4570594cad17214dddb01d1efc567e4`.
Task prompts, hidden verifiers, raw Agent events, process reports, cloned run
repositories, isolated RepoMind databases, and per-run hashes are retained in
that workspace.

## Continuous tasks

Task 1 asked Claude Code, in a fresh non-persistent session, to add readonly
`limit.isIdle` behavior across the runtime, TypeScript declaration, README,
AVA tests, and tsd tests. Claude changed only the five allowlisted files.
Independent `npx ava`, `npx tsd`, and the external hidden verifier passed.

RepoMind committed seven Evidence records and extracted six L1 memories. The
two memories selected for Task 2 were:

- solution `mem_0dc72b3b-b23e-4b41-bd4a-e44ce9dfa700`, binding Git snapshot,
  Git diff, test results, command result, Agent summary, and all five file
  hashes; and
- decision `mem_9c0edabe-647a-4e31-b7d1-13b7d4cf8726`, recording that a public
  API property must update `index.js`, `index.d.ts`, `readme.md`, `test.js`, and
  `index.test-d.ts`.

Task 2 asked fresh OpenCode sessions to add readonly `limit.isSaturated`. Its
prompt described the behavior but did not repeat Task 1's five-file convention.
Every arm cloned the same Task 1 commit, used the same model, prompt wrapper,
Agent restrictions, dependency tree, 10-minute timeout, public checks, hidden
verifier, and allowlist. The only treatment difference was the two Task 1
memories injected by the Host-managed RepoMind lifecycle. Execution order was
rotated across repetitions.

The upstream aggregate `npm test` fails before any task change on this Windows
host because XO cannot attach the declaration files to its TypeScript project
service and reports an existing TODO warning. The protocol recorded this before
Agent execution. Independent AVA and tsd commands pass on the upstream state
and were therefore the fixed public checks.

## Results

| Repeat | Arm | Public | Hidden | Retrieved | File reads | Input Tokens | Output Tokens | Agent ms |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | no-memory | pass | pass | 0 | 6 | 25,983 | 2,428 | 114,653 |
| 1 | RepoMind | pass | pass | 2 | 6 | 16,376 | 2,059 | 106,587 |
| 2 | RepoMind | pass | pass | 2 | 6 | 13,975 | 2,092 | 95,512 |
| 2 | no-memory | pass | pass | 0 | 6 | 33,303 | 2,073 | 124,848 |
| 3 | no-memory | pass | pass | 0 | 6 | 16,665 | 2,068 | 104,740 |
| 3 | RepoMind | pass | pass | 2 | 6 | 14,385 | 1,915 | 81,794 |

| Metric | No memory | RepoMind | Change |
| --- | ---: | ---: | ---: |
| Public pass rate | 100% | 100% | 0 pp |
| Hidden pass rate | 100% | 100% | 0 pp |
| Mean input Tokens | 25,317 | 14,912 | **-41.1%** |
| Mean output Tokens | 2,190 | 2,022 | **-7.7%** |
| Mean reasoning Tokens | 738 | 695 | **-5.8%** |
| Mean Agent duration | 114,747 ms | 94,631 ms | **-17.5%** |
| Mean file reads | 6 | 6 | 0 |
| Mean repeated file reads | 0 | 0 | 0 |

RepoMind input-Token deltas were `-9,607`, `-19,328`, and `-2,280`; Agent
duration deltas were `-8,066`, `-29,336`, and `-22,945` ms. Thus every paired
repeat improved both primary efficiency measures. No file-read benefit is
claimed.

Each RepoMind run retrieved the same two relevant Task 1 memories, made zero
Agent-side RepoMind calls, wrote commit Evidence, and left zero open Sessions
or running Host Runs. The memories were active before Task 2. Post-run inspect
correctly reported them uncertain after Task 2 changed their related files;
this is stale-file detection, not a false recall.

## Transparent correction

The first generated summary reported acceptance failure. Its SHA-256 is
`0dc33ae0a67923bba88881d93078a4f84bd8cbc089b976b701e531f2d6b1e0ad`.
The v1 runner incorrectly required `sessionStatus === committed`, although the
registered gate required a successful lifecycle commit. All six Agents tried
the known-failing upstream `npm test`; RepoMind therefore conservatively closed
its three sessions as `partial` after targeted checks passed. Each partial
session had commit Evidence and a non-null commit duration, and all three
databases reported zero open Sessions.

No Agent run was repeated. A read-only reanalysis accepted both `committed` and
`partial` as closed, successfully committed lifecycle states when commit
Evidence exists and no Session or Host Run remains open. The formal JSON
SHA-256 is
`25afc3699a169d92b027fbe99f2d000fc3170f63f14e32e28d0920eaf5320398`.
All ten formal gates passed: run integrity, public and hidden outcomes,
retrieval, lifecycle commits, session cleanup, false recall, aggregate
efficiency, paired input-Token benefit, and paired duration benefit.

## Limits

- This is one external repository, one continuous task pair, one operating
  system, and three repetitions. It is evidence for a real benefit case, not a
  population-wide causal estimate.
- Task 1 created a local acceptance commit; it was not proposed or pushed to
  the upstream project.
- File reads tied because both Agents inspected all public API surfaces. The
  observed benefit came from smaller model input and shorter execution time.
- Provider currency cost is not reported because a stable public price
  schedule was not part of the protocol.
