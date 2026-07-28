# RepoMind v0.8 host-managed controlled agent benchmark results

This document records the formal report-v5 acceptance run for the host-managed
lifecycle introduced in RepoMind v0.8. The experiment completed all 72 planned
Agent runs, passed every integrity check, and passed every predeclared outcome
acceptance gate.

The executable identified itself as `0.7.1` during the run because the version
bump was deliberately deferred until after acceptance. The tested clean commit,
`197bddfa2542aea695266ec4105a9a3645cad030`, contains the complete host-managed
runtime shipped in v0.8. Only release metadata and documentation changed between
that commit and the v0.8 release candidate; no benchmark execution logic was
changed after the formal run.

## Verdict

| Question | Result |
| --- | --- |
| Was the experiment valid? | Yes: all 72 planned runs passed integrity validation. |
| Did RepoMind beat no memory on hidden checks? | Yes: 24/24 versus 12/24. |
| Did RepoMind match full history on hidden checks? | Yes: both passed 24/24. |
| Did RepoMind meet the full-history duration gate? | Yes: 12.711% faster, with a 15% maximum regression allowed. |
| Did RepoMind meet every configured gate? | Yes. |
| Formal v0.8 acceptance | **passed** |

## Provenance

| Field | Value |
| --- | --- |
| Generated at | `2026-07-28T05:52:44.393Z` (`2026-07-28 13:52:44`, Asia/Shanghai) |
| Reported RepoMind version | `0.7.1` (pre-release version metadata) |
| Tested RepoMind commit | `197bddfa2542aea695266ec4105a9a3645cad030` |
| Tested worktree dirty | `false` |
| Release version | `0.8.0` |
| Model | `cliproxyapi/gpt-5.6-terra` |
| Runner | OpenCode `1.18.7` |
| Runner isolation | `opencode run --pure` |
| Lifecycle | `host-managed` |
| Node.js | `v22.20.0` |
| Operating system | Windows `win32 10.0.26200 x64` |
| Manifest SHA-256 | `9799cf44f4ba0e4e59d48bd20b22a15f301fdec5c45bd4a1681db51e65ba15c1` |
| `summary.json` SHA-256 | `540c9611f3237d01c755cdd4228e6bb9f7ab46070f1877ec0162330d6d067ceb` |
| `summary.md` SHA-256 | `29a1b899519bb596965a74c44b3870e8f7cdfdb73aaef5dc456e42ed3ca10575` |
| `profile.json` SHA-256 | `8f687f196c8d5035a2644c9d435b421626e56209a4d10ca40eb993815307eaef` |
| `profile.md` SHA-256 | `7277e5999e30678cdd51a438a0525ff6a07ff3f36b60cc48def1b956e1991f9c` |

The source report is retained at
`D:\data\code\project\repomind-test\results-host-managed-formal-20260728`.
The independently generated phase profile is retained at
`D:\data\code\project\repomind-test\results-host-managed-formal-20260728-profile`.

| Task | Base commit |
| --- | --- |
| `renamed-module` | `14a35ca67e878584b3b2ae35a621b961eda7fe8a` |
| `failed-solution` | `565512aae51d6108774068ebee7fa81c8eedfd2f` |
| `migration-rollback` | `bd7d5c00612d70852c1814205538911eb556ca59` |
| `historical-command` | `76c1ded92559e909ba05933bfece3b77860e272d` |
| `stale-endpoint` | `059a83f5e2b35a32aa2f4ffae5a7621913b57ebc` |
| `error-contract` | `e10f1e5c09ffdbcc06c855851855e08b275bc658` |
| `dependency-boundary` | `db16b57646fa71bd631c6a1620439dc5459b538c` |
| `config-default` | `4e7df231c78977289150e45984ae5a27ee317fa8` |

## Method

The suite contains eight tasks, three repetitions, and three arms, for 72
Agent runs. Every run starts from a fresh clone at the recorded task commit.
The no-memory arm receives no historical context. The full-history arm receives
raw task history. The RepoMind arm receives evidence-backed memories retrieved
before Agent execution. A Latin-square schedule rotates arm order across
repetitions.

In host-managed mode, the runner starts the RepoMind session, retrieves memory,
and injects that context into the task prompt before OpenCode starts. RepoMind
MCP tools are not exposed inside the Agent loop. After OpenCode exits, the host
extracts the final response and command evidence and commits the session.
External public and hidden checks execute after that commit and are not written
back into memory.

Each RepoMind run uses an isolated data directory. OpenCode runs with `--pure`,
preventing global plugins from adding tools, MCP servers, or prompt behavior.
Hidden verifiers remain outside the task repositories. Integrity and outcome
acceptance are evaluated separately, and all thresholds were fixed in the
manifest before the run.

## Overall results

| Metric | No memory | Full history | RepoMind |
| --- | ---: | ---: | ---: |
| Agent clean exits | 24/24 | 24/24 | 24/24 |
| Public checks | 24/24 | 24/24 | 24/24 |
| Hidden checks | 12/24 | 24/24 | 24/24 |
| Mean total time | 64.675 s | 44.705 s | 39.023 s |
| Mean lifecycle start | n/a | n/a | 0.231 s |
| Mean Agent time | 64.675 s | 44.705 s | 38.285 s |
| Mean lifecycle commit | n/a | n/a | 0.506 s |
| Mean input tokens | 6,814 | 5,335 | 4,650 |
| Mean output tokens | 1,068 | 802 | 664 |
| Mean file reads | 3.667 | 2.750 | 2.667 |
| Mean Agent turns | 9.417 | 7.333 | 6.250 |
| Mean Agent tool calls | 13.083 | 9.667 | 7.958 |

Lower is preferred for duration, tokens, file reads, turns, and tool calls.
Higher is preferred for check success.

## Paired comparisons

### RepoMind versus no memory

| Metric | Baseline mean | RepoMind mean | Mean delta | Approximate 95% interval | Win/tie/loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden success | 0.500 | 1.000 | +0.500 | not profiled | 12/12/0 |
| Wall time | 64.675 s | 39.023 s | -25.652 s (-39.663%) | -35.364 to -15.940 s | 22/0/2 |
| Input tokens | 6,814 | 4,650 | -2,164 (-31.761%) | -3,432 to -896 | 17/0/7 |
| Output tokens | 1,068 | 664 | -404 (-37.803%) | -545 to -262 | 23/0/1 |
| File reads | 3.667 | 2.667 | -1.000 (-27.273%) | not profiled | 9/15/0 |

### RepoMind versus full history

| Metric | Baseline mean | RepoMind mean | Mean delta | Approximate 95% interval | Win/tie/loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden success | 1.000 | 1.000 | 0 | not profiled | 0/24/0 |
| Wall time | 44.705 s | 39.023 s | -5.682 s (-12.711%) | -11.266 to -0.099 s | 16/0/8 |
| Input tokens | 5,335 | 4,650 | -686 (-12.849%) | -1,507 to +136 | 17/0/7 |
| Output tokens | 802 | 664 | -138 (-17.211%) | -247 to -29 | 17/0/7 |
| Agent turns | 7.333 | 6.250 | -1.083 (-14.773%) | -2.084 to -0.083 | 12/9/3 |
| Agent tool calls | 9.667 | 7.958 | -1.708 (-17.672%) | -2.993 to -0.424 | 16/1/7 |

The full-history wall-time interval is entirely below zero, but it ends close
to zero. The result supports a speed improvement in this controlled sample; it
does not establish the same effect for other models, runners, or repositories.

## Host-managed lifecycle audit

| Check | Result |
| --- | ---: |
| Session starts succeeded | 24/24 |
| Runs retrieving at least one memory | 24/24 |
| Session commits succeeded | 24/24 |
| Sessions committed | 24/24 |
| RepoMind MCP calls inside Agent runs | 0 |
| Open sessions after cleanup | 0 |
| Abandoned sessions | 0 |
| Mean session-start time | 231.383 ms |
| Mean Agent time | 38,285.467 ms |
| Mean session-commit time | 505.914 ms |
| Mean total lifecycle time | 39,022.764 ms |
| Maximum lifecycle phase reconciliation error | 0 ms |

Host work averaged 737.297 ms per RepoMind run, 1.89% of total lifecycle time.
This removes the extra model turns that the v0.7 agent-managed protocol used to
request session start and construct a commit payload.

## Acceptance gates

| Gate | Measured | Target | Result |
| --- | ---: | ---: | --- |
| Experiment integrity | `true` | `true` | passed |
| RepoMind hidden pass rate | `1.000` | `>= 1.000` | passed |
| Hidden delta versus no memory | `+0.500` | `>= 0` | passed |
| Hidden delta versus full history | `0` | `>= 0` | passed |
| Retrieval rate | `1.000` | `>= 1.000` | passed |
| Session commit rate | `1.000` | `>= 1.000` | passed |
| Duration regression versus no memory | `-39.663%` | `<= 15%` | passed |
| Duration regression versus full history | `-12.711%` | `<= 15%` | passed |
| Token or file-read improvement versus no memory | `true` | `true` | passed |
| Required `historical-command` win versus no memory | `+1.000` | `> 0` | passed |

## Integrity audit

- All 72 expected JSONL files, stderr files, run directories, and isolated data
  directories exist.
- All stderr files are empty; no planned run is missing, duplicated, or extra.
- Every Agent process exited normally and all public checks passed.
- Every run used its requested base commit and made only allowed file changes.
- Neither baseline arm used RepoMind.
- Every RepoMind run retrieved memory and committed its session, with no
  RepoMind MCP call exposed to the Agent and no session left open.
- The offline profile reconstructed and reconciled all 72 timelines without an
  integrity failure.

## Relationship to the v0.7 result

The preserved v0.7 agent-managed result passed experiment integrity but failed
outcome acceptance because RepoMind was 39.713% slower than full history. The
new host-managed result is 12.711% faster than full history, a 52.424 percentage
point change in the measured relative delta. Mean RepoMind wall time changed
from 75.291 seconds in the v0.7 experiment to 39.023 seconds here.

These values come from different experiment executions and OpenCode versions,
so their direct difference is diagnostic rather than a paired causal estimate.
The formal v0.8 conclusion rests on the 24 within-report pairs above. The v0.7
negative result remains unchanged in
[`agent-benchmark-results-v0.7.md`](agent-benchmark-results-v0.7.md).

## Limits

- RepoMind's authors designed the eight small JavaScript fixtures, creating
  selection bias and limiting external validity.
- The experiment covers one model alias, one runner version, one operating
  system, and one date.
- Raw full history is short and directly injected. Real repositories may have
  histories too large or noisy to supply this way, but this experiment does
  not measure that scaling point.
- Three repetitions per task remain a small sample. The reported intervals use
  a normal approximation over paired deltas.
- OpenCode event token counts were not independently recomputed with a separate
  tokenizer.
- External public and hidden checks intentionally run after session commit, so
  their results do not become memory evidence in this protocol.
- Host-managed lifecycle behavior is available as an opt-in mode; the default
  remains agent-managed for backward compatibility.
