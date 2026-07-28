# RepoMind v0.7 three-arm controlled agent benchmark results

This document records the formal report-v4 run for RepoMind v0.7.1. The
experiment passed every integrity check, but failed the predeclared outcome
acceptance criteria. The only failed gate was mean wall-time regression against
the full-history arm: 39.713% measured versus a maximum of 15%.

This is a valid negative acceptance result. It must not be described as a
successful v0.7 outcome acceptance.

## Verdict

| Question | Result |
| --- | --- |
| Was the experiment valid? | Yes: integrity passed with no failures. |
| Did RepoMind beat no memory on hidden checks? | Yes: 24/24 versus 12/24. |
| Did RepoMind beat full history on hidden checks? | No: both passed 24/24. |
| Did RepoMind meet every configured gate? | No: full-history duration regression failed. |
| Formal v0.7 acceptance | **failed** |

## Provenance

| Field | Value |
| --- | --- |
| Generated at | `2026-07-28T03:23:56.254Z` (`2026-07-28 11:23:56`, Asia/Shanghai) |
| RepoMind version | `0.7.1` |
| RepoMind commit | `692c15e6cb4c262835ad86aa4cc12217c456dd60` |
| Git tag | `v0.7.1` |
| Worktree dirty | `false` |
| Model | `cliproxyapi/gpt-5.6-terra` |
| Runner | OpenCode `1.18.5` |
| Runner isolation | `opencode run --pure` |
| Node.js | `v22.20.0` |
| Operating system | Windows `win32 10.0.26200 x64` |
| Manifest SHA-256 | `9799cf44f4ba0e4e59d48bd20b22a15f301fdec5c45bd4a1681db51e65ba15c1` |
| Source report SHA-256 | `52195100fc16a0c10249a4a1670c7f844c20837fe2ea41c0d9fb697bf58447c1` |
| Aggregate report SHA-256 | `49cdbfd690c8cdffa96c8c143251e7a81c841de60fa2256b41dac1fcb01905d5` |

The source report is retained at
`D:\data\code\project\repomind-test\results-v0.7\windows-opencode-gpt-5.6-terra-20260728\summary.json`.
The independently generated aggregate is retained under
`D:\data\code\project\repomind-test\agent-summary-v0.7-formal-20260728`.

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
The no-memory arm receives no historical context, the full-history arm receives
the raw task history, and the RepoMind arm retrieves an evidence-backed memory
through its isolated MCP server. A Latin-square schedule rotates arm order
across repetitions.

Hidden verifiers remain outside the task repositories. Each RepoMind run gets
an isolated data directory. OpenCode runs with `--pure`, preventing global
plugins from adding tools, MCP servers, or prompt behavior. Integrity and
outcome acceptance are evaluated separately, and the acceptance thresholds
were fixed in the manifest before the run.

## Overall results

| Metric | No memory | Full history | RepoMind |
| --- | ---: | ---: | ---: |
| Agent clean exits | 24/24 | 24/24 | 24/24 |
| Public checks | 24/24 | 24/24 | 24/24 |
| Hidden checks | 12/24 | 24/24 | 24/24 |
| Mean wall time | 67.683 s | 53.890 s | 75.291 s |
| Mean input tokens | 8,552 | 6,598 | 11,160 |
| Mean output tokens | 1,242 | 1,079 | 1,575 |
| Mean file reads | 3.333 | 2.958 | 3.083 |
| Mean Agent turns | 9.542 | 8.542 | 11.375 |
| RepoMind MCP calls | 0 | 0 | 49 |

Lower is preferred for duration, tokens, file reads, and turns. Higher is
preferred for check success. The 49 MCP calls consist of 24 session starts, 24
session commits, and one valid memory-record call in a RepoMind run.

## Paired comparisons

### RepoMind versus no memory

| Metric | Baseline mean | RepoMind mean | Mean delta | Approximate 95% interval | Win/tie/loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden success | 0.500 | 1.000 | +0.500 | +0.296 to +0.704 | 12/12/0 |
| Public success | 1.000 | 1.000 | 0 | 0 to 0 | 0/24/0 |
| Wall time | 67.683 s | 75.291 s | +7.609 s | +0.382 to +14.835 s | 10/0/14 |
| Input tokens | 8,552 | 11,160 | +2,608 | +1,353 to +3,862 | 5/0/19 |
| Output tokens | 1,242 | 1,575 | +333 | +202 to +464 | 5/0/19 |
| File reads | 3.333 | 3.083 | -0.250 | -0.781 to +0.281 | 7/12/5 |

### RepoMind versus full history

| Metric | Baseline mean | RepoMind mean | Mean delta | Approximate 95% interval | Win/tie/loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden success | 1.000 | 1.000 | 0 | 0 to 0 | 0/24/0 |
| Public success | 1.000 | 1.000 | 0 | 0 to 0 | 0/24/0 |
| Wall time | 53.890 s | 75.291 s | +21.401 s | +14.515 to +28.287 s | 3/0/21 |
| Input tokens | 6,598 | 11,160 | +4,562 | +2,842 to +6,282 | 3/0/21 |
| Output tokens | 1,079 | 1,575 | +496 | +385 to +608 | 1/0/23 |
| File reads | 2.958 | 3.083 | +0.125 | -0.171 to +0.421 | 3/14/7 |

## Per-task hidden outcomes

| Task | No memory | Full history | RepoMind | RepoMind duration vs no memory | RepoMind duration vs full history |
| --- | ---: | ---: | ---: | ---: | ---: |
| `renamed-module` | 3/3 | 3/3 | 3/3 | +44.332% | +13.229% |
| `failed-solution` | 3/3 | 3/3 | 3/3 | +21.797% | +42.685% |
| `migration-rollback` | 3/3 | 3/3 | 3/3 | +18.494% | +49.472% |
| `historical-command` | 0/3 | 3/3 | 3/3 | -10.227% | +28.717% |
| `stale-endpoint` | 0/3 | 3/3 | 3/3 | +33.270% | +96.046% |
| `error-contract` | 0/3 | 3/3 | 3/3 | -20.058% | +17.112% |
| `dependency-boundary` | 3/3 | 3/3 | 3/3 | +34.852% | +72.381% |
| `config-default` | 0/3 | 3/3 | 3/3 | +1.540% | +27.017% |

RepoMind gained all 12 hidden-check wins against no memory on four tasks and
had no hidden-check losses. Raw full history also solved all four of those
tasks, so this suite demonstrated the value of available historical context,
but not a quality advantage for RepoMind over directly supplied history.

## Acceptance gates

| Gate | Measured | Target | Result |
| --- | ---: | ---: | --- |
| Experiment integrity | `true` | `true` | passed |
| RepoMind hidden pass rate | `1.000` | `>= 1.000` | passed |
| Hidden delta versus no memory | `+0.500` | `>= 0` | passed |
| Hidden delta versus full history | `0` | `>= 0` | passed |
| Retrieval rate | `1.000` | `>= 1.000` | passed |
| Session commit rate | `1.000` | `>= 1.000` | passed |
| Duration regression versus no memory | `11.242%` | `<= 15%` | passed |
| Duration regression versus full history | `39.713%` | `<= 15%` | **failed** |
| Token or file-read improvement versus no memory | `true` | `true` | passed |
| Required `historical-command` win versus no memory | `+1.000` | `> 0` | passed |

The efficiency gate passed only because mean file reads were 7.5% lower than
no memory. Its confidence interval includes zero, while both input and output
token means were higher. It should not be interpreted as broad efficiency
evidence.

## Integrity audit

- All 72 expected JSONL files exist with no missing, duplicate, or extra run.
- The audit parsed 2,413 events with no malformed JSON, Agent timeout, Agent
  error, or failed tool.
- All 72 Agent processes exited normally and all public checks passed.
- Every run used the requested base commit and made only allowed file changes.
- All 72 stderr files are empty.
- No global plugin, skill, background Agent, or delegation tool was observed.
- Neither baseline arm made a RepoMind call.
- All 24 RepoMind runs retrieved exactly one seeded memory and committed their
  session; no session remained open or was abandoned.

## Interpretation and next acceptance work

RepoMind delivered a clear quality benefit when compared with having no
historical context. It did not improve quality over full history on this suite,
and its additional Agent turns and tokens created a material cost. The
full-history mean was 53.890 seconds, so the configured 15% ceiling permits at
most 61.974 seconds. RepoMind would need to reduce its current mean by about
13.318 seconds to meet that gate on an otherwise comparable run.

The next iteration should reduce the mandatory session protocol and prompt
overhead, then rerun the unchanged manifest and acceptance thresholds in a new
output directory. A replacement run must be reported alongside this result,
not substituted for it.

## Limits

- RepoMind's authors designed all eight small JavaScript fixtures, creating
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
- The result evaluates RepoMind as an end-to-end Agent protocol and does not
  isolate storage, retrieval, MCP, prompt, or session-commit costs.
