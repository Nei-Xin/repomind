# RepoMind v0.13 quality and cross-Agent evidence

## Coverage

The complete 144-test suite was measured with Vitest 3.2.7 and the matching V8
provider. Coverage is restricted to `src/**/*.ts`, so benchmark fixtures and
generated test repositories do not dilute or inflate the product-code result.

| Metric | Local baseline | Enforced floor |
| --- | ---: | ---: |
| Statements | 83.00% | 80% |
| Branches | 77.14% | 75% |
| Functions | 94.33% | 90% |
| Lines | 83.00% | 80% |

`npm run test:coverage` generates text, HTML, JSON summary, and LCOV reports.
CI builds the package, runs the same command on Ubuntu, and uploads the complete
`coverage/` directory. The floors are initial regression guards, not a claim
that every critical path is sufficiently tested.

## macOS

The main CI verification matrix includes `macos-latest` alongside Ubuntu and
Windows. GitHub Actions
[CI run 30358584725](https://github.com/Nei-Xin/repomind/actions/runs/30358584725)
passed all five jobs for commit `fd8093c` on 2026-07-28. The macOS job completed
in 1 minute 24 seconds and passed install, typecheck, build, all 144 tests, and
the rebuildable eight-task Agent fixture validation. Ubuntu, Windows, coverage,
and comparison benchmark jobs also passed. The coverage artifact was 690 KB
with digest
`sha256:ab379442663256d35a4c5fde2e62a124ac90ac9fdad71c2a88d4a1b91c176a2b`.

## Second real Coding Agent

The acceptance target is the existing v0.10 repository and data directory
created by real OpenCode runs. The accepted test used Claude Code 2.1.220 with
an isolated `--mcp-config` and `--strict-mcp-config`; it did not change
OpenCode or Codex configuration. Claude Code used its configured
`gpt-5.6-luna` model, so this proves a second real Agent host and MCP client,
not an Anthropic-model comparison.

The first attempt was blocked before MCP by an expired OAuth session. After
authentication was restored, the formal run on 2026-07-28 passed:

- Claude Code discovered all 18 RepoMind tools and reported the MCP server as
  connected.
- `repo_memory_search` read four memories created by the earlier OpenCode runs,
  including the same active verified-command memory and two stale warnings.
- `repo_memory_inspect` returned memory
  `mem_fecf31ac-3e60-424d-9bfa-2723e78b6811`, one `test_result` Evidence item,
  commit `2e0a80822d00aa387995131c58079288ec0ebd04`, and three related files.
- `repo_profile_rebuild` created current L3 profile
  `l3_41d61e91-a4bd-4282-8a7b-d80d63947c67`, version 1, from the eligible
  OpenCode-created L1 source.
- `repo_session_start` injected that current profile. A separate Claude Code
  process called `repo_session_abandon` for
  `ses_0ad277d1-fa45-4aef-8e62-9be530378fef`.
- New Claude Code sessions independently repeated memory search and retrieved
  the same persisted L3 profile through `repo_profile_get`.
- CLI verification reported four memories, one repository profile, no open
  Sessions, no running Host Runs, and a clean target Git worktree.

The isolated configuration, prompts, initial authentication failure, and final
acceptance summary are stored in:

```text
D:\data\code\project\repomind-test\v0.13-cross-agent-claude-20260728
```

Result: **accepted**. This proves OpenCode and Claude Code can access one
repository-scoped RepoMind database across independent processes. It does not
evaluate relative model quality or remote LLM extraction.
