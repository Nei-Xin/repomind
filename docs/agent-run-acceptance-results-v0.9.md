# RepoMind v0.9 daily host-run acceptance results

This document records the formal eight-task acceptance of the daily
`repomind run` entry point introduced in RepoMind v0.9. All eight tasks passed
the product-path checks and the report passed integrity validation.

The executable reported version `0.8.0` because the release metadata bump was
deliberately deferred until after acceptance. The exact tested source tree was
then committed as `e88042e7772aac39661b2dcab02b534a3566f15e`; only release metadata
and this result document changed afterward.

## Verdict

| Question | Result |
| --- | --- |
| Did all eight tasks retrieve memory? | Yes: 8/8 retrieved one relevant memory. |
| Did every Agent complete cleanly? | Yes: 8/8 exited with code 0. |
| Did Agents bypass the host lifecycle? | No: Agent RepoMind calls were 0. |
| Did all sessions commit and close? | Yes: 8/8 committed, with 0 open sessions. |
| Did public and hidden checks pass? | Yes: 8/8 for both check sets. |
| Were artifacts and file changes valid? | Yes: every artifact and allowlist check passed. |
| Formal v0.9 acceptance | **passed** |

## Provenance

| Field | Value |
| --- | --- |
| Generated at | `2026-07-28T07:21:16.549Z` (`2026-07-28 15:21:16`, Asia/Shanghai) |
| Reported RepoMind version | `0.8.0` (pre-release version metadata) |
| Tested source commit | `e88042e7772aac39661b2dcab02b534a3566f15e` |
| Release version | `0.9.0` |
| Model | `cliproxyapi/gpt-5.6-terra` |
| Runner | OpenCode `1.18.7` |
| Runner isolation | `opencode run --pure` with RepoMind MCP disabled |
| Node.js | `v22.20.0` |
| Operating system | Windows `win32 10.0.26200 x64` |
| Manifest version | `2` |
| Manifest SHA-256 | `f18d7eff043e9e80682dec95ab6fff22f88b6be5cb0f4826376077de19342511` |
| `summary.json` SHA-256 | `d698291ec2e6010dfdd257b5e5eadc49845940e6c0c2ebf29270998fbdc4ec2d` |
| `summary.md` SHA-256 | `576c47a32714e059b406d2a6290cb1d24119d7e4bbdc3434ceef98eb0cbe5737` |

The complete workspace is retained at
`D:\data\code\project\repomind-test\host-run-acceptance-v0.9-formal`.

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

The acceptance command rebuilt the manifest-v2 suite from ordinary templates
in a new external workspace. It cloned every task at its recorded base commit,
initialized an isolated RepoMind database, seeded the task's manifest memory,
and invoked the same exported `runOpenCodeHost` implementation used by the
daily CLI command.

The host started the session, retrieved and injected memory, disabled RepoMind
MCP inside OpenCode, ran the Agent, captured command and test evidence, and
committed the session. Only afterward did the harness run public and external
hidden checks. It also inspected Git changes, open sessions, report structure,
artifact presence, and unredacted secret patterns. Strict mode made any failed
task or integrity check return a nonzero process exit code.

## Results

| Task | Retrieved | Start ms | Agent ms | Commit ms | Input tokens | Output tokens | Changed files |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `renamed-module` | 1 | 250.3 | 84,427.4 | 518.8 | 11,942 | 1,218 | `src/index.js` |
| `failed-solution` | 1 | 243.7 | 61,144.5 | 495.2 | 7,137 | 1,400 | `src/delivery.js`, `test/smoke.node.js` |
| `migration-rollback` | 1 | 290.6 | 32,870.9 | 536.6 | 3,670 | 605 | `migrations/20260727-user-handle.js` |
| `historical-command` | 1 | 253.0 | 27,978.6 | 509.1 | 2,748 | 451 | `package.json` |
| `stale-endpoint` | 1 | 234.8 | 27,640.5 | 549.3 | 3,442 | 553 | `src/client.js` |
| `error-contract` | 1 | 229.5 | 71,817.9 | 552.8 | 7,386 | 1,313 | `src/parse-config.js`, `test/smoke.node.js` |
| `dependency-boundary` | 1 | 230.6 | 41,573.3 | 531.0 | 5,017 | 619 | `src/digest.js` |
| `config-default` | 1 | 227.9 | 50,031.8 | 517.1 | 7,410 | 1,072 | `src/config.js`, `test/smoke.node.js` |

| Aggregate | Result |
| --- | ---: |
| Accepted tasks | 8/8 |
| Retrieval, session commit, public checks, hidden checks | 8/8 each |
| Agent RepoMind calls | 0 |
| Open sessions after each run | 0 |
| Mean session start | 245.0 ms |
| Mean Agent duration | 49,685.6 ms |
| Mean session commit | 526.2 ms |
| Total input/output tokens | 48,752 / 7,231 |
| Evidence created | 40 |
| Memories stored/skipped/conflicted | 11 / 0 / 0 |
| Artifact redactions required | 0 |

## Integrity audit

- Every task started at its recorded commit and changed only allowlisted files.
- All expected `events.jsonl`, `stderr.log`, and `run.json` artifacts exist and
  the stored reports match their returned session identifiers.
- All persisted artifacts passed the unredacted-secret scan.
- Every Agent exited normally, made zero RepoMind calls, and produced a
  committed lifecycle report.
- All public and external hidden checks passed, with no open session left after
  any task.

## Limits

- This is a product-path acceptance suite, not a comparison against no-memory
  or full-history baselines. Comparative conclusions remain in the v0.8
  controlled 72-run report.
- The suite uses eight small JavaScript fixtures designed by RepoMind's
  authors, one model alias, one OpenCode version, one operating system, and one
  execution per task.
- Agent duration and token counts are observational. This acceptance establishes
  correctness and lifecycle integrity, not general performance superiority.
- Hidden checks run outside the model and after session commit, so their results
  are not stored as session evidence.
