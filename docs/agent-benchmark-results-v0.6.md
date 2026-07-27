# RepoMind v0.6 controlled agent benchmark results

This document records the formal three-repeat acceptance run used for the
v0.6.0 release. The tested candidate predates the release commit; the exact
candidate commit is recorded below so the result is not attributed to later
documentation or version-only changes.

## Provenance

| Field | Value |
| --- | --- |
| Generated at | `2026-07-27T16:12:56.429Z` (`2026-07-28`, Asia/Shanghai) |
| RepoMind candidate | `0.5.0` pre-release |
| RepoMind commit | `5790ffa29768bcafbb16c08c78bd55875a16575c` |
| Model | `cliproxyapi/gpt-5.6-terra` |
| Runner | OpenCode `1.18.5` |
| Node.js | `v22.20.0` |
| Operating system | Windows `win32 10.0.26200 x64` |
| Manifest SHA-256 | `56241d2746a0644f4ebcdfea319076a6933c67ba5dbd9840f3688ce0a98771c6` |
| `renamed-module` base | `dad606ae47c3fdb0dc77d6f9531573f43cbe6bc9` |
| `failed-solution` base | `7ebcefd433683bed4f0b282faadec1c9f6877ef3` |
| `migration-rollback` base | `764fc4ebdc28d846f94aa964b2246095e98bcd10` |
| `historical-command` base | `6d2d4b2c602f6927959ea1e4da2f00d437350927` |

The v0.6 runner now writes these fields into every generated JSON and Markdown
report. The values above were preserved from the formal run's manifest,
repositories, runtime, and runner output before that automation was added.

## Method

The suite contains four tasks and runs each task three times in both arms: 12
paired comparisons and 24 agent runs. Every arm starts from a fresh clone of
the same task commit. A/B execution order alternates by repetition. Hidden
checks remain outside the working repository, and each RepoMind arm receives
an isolated data directory. The no-memory arm has no RepoMind MCP server.

Public checks measure ordinary repository health. External hidden checks
measure the requested behavior without exposing the expected answer to the
agent. Integrity and outcome acceptance are evaluated separately.

## Overall paired results

| Metric | No memory | RepoMind | Relative change | RepoMind win/tie/loss |
| --- | ---: | ---: | ---: | ---: |
| Hidden checks | 9/12 | 12/12 | +25 percentage points | 3/9/0 |
| Public checks | 12/12 | 12/12 | 0 | 0/12/0 |
| Mean wall time | 87.8 s | 92.2 s | +4.995% | 4/0/8 |
| Mean input tokens | 13,550 | 9,952 | -26.554% | 8/0/4 |
| Mean output tokens | 1,438 | 1,407 | -2.184% | 6/0/6 |
| Mean file reads | 3.750 | 3.167 | -15.556% | 6/4/2 |

Lower is preferred for wall time, tokens, and file reads. Higher is preferred
for check success. RepoMind gained all three hidden-check wins on the
`historical-command` task and had no hidden-check losses.

## Per-task results

| Task | Pairs | Hidden no memory | Hidden RepoMind | Duration | Input tokens | File reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `renamed-module` | 3 | 3/3 | 3/3 | +35.518% | +21.271% | -10% |
| `failed-solution` | 3 | 3/3 | 3/3 | +21.648% | +16.745% | -10% |
| `migration-rollback` | 3 | 3/3 | 3/3 | +1.383% | -41.262% | +16.667% |
| `historical-command` | 3 | 0/3 | 3/3 | -19.468% | -48.810% | -53.846% |

## Acceptance gates

| Gate | Measured | Target | Result |
| --- | ---: | ---: | --- |
| Experiment integrity | `true` | `true` | passed |
| RepoMind hidden pass rate | `1.00` | `>= 1.00` | passed |
| Hidden pass-rate delta | `0.25` | `>= 0` | passed |
| Retrieval rate | `1.00` | `>= 1.00` | passed |
| Session commit rate | `1.00` | `>= 1.00` | passed |
| Mean duration regression | `4.995%` | `<= 15%` | passed |
| Token or file-read improvement | `true` | `true` | passed |
| Required `historical-command` win | `1.00` | `> 0` | passed |

The formal run passed both experiment integrity and every configured acceptance
gate.

## Integrity observations

- All 24 agent processes exited normally.
- All 12 RepoMind runs retrieved at least one memory.
- All 12 RepoMind sessions committed and no session remained open.
- No run made an unexpected file change.
- No runner stderr was recorded.
- No-memory runs made no RepoMind calls.

## Limits

- RepoMind's authors designed the fixtures, which creates selection bias.
- The suite has only four small JavaScript tasks.
- The run covers one model, one runner version, and one operating system.
- `historical-command` is deliberately constructed so required information is
  absent from the repository; it tests the intended memory advantage directly.
- Token counts come from OpenCode events and were not independently recomputed
  with a separate tokenizer.
- Three repetitions are insufficient for strong latency conclusions.
- The A/B design measures RepoMind as a whole and does not isolate the effect
  of each internal retrieval, session, or storage mechanism.

The result demonstrates a controlled benefit on this suite. It is not evidence
that RepoMind improves every repository, task, model, or runtime environment.
