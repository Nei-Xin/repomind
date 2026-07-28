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
CI runs the same command on Ubuntu and uploads the complete `coverage/`
directory. The floors are initial regression guards, not a claim that every
critical path is sufficiently tested.

## macOS

The main CI verification matrix includes `macos-latest` alongside Ubuntu and
Windows. A configuration change alone is not macOS proof; the exact GitHub
Actions run and job result must be recorded after the commit is pushed.

## Second real Coding Agent

The acceptance target is the existing v0.10 repository and data directory
created by real OpenCode runs. The test uses Claude Code 2.1.220 with a
one-command `--mcp-config` and `--strict-mcp-config`; it does not change Claude,
OpenCode, or Codex global configuration.

The first attempt on 2026-07-28 did not reach RepoMind. Claude Code reported
`OAuth session expired and could not be refreshed`, with zero input/output
tokens and zero cost. Therefore second-Agent interoperability is **not yet
accepted**. After Claude authentication is restored, rerun the two prompts in:

```text
D:\data\code\project\repomind-test\v0.13-cross-agent-claude-20260728
```

Acceptance requires tool discovery, memory search and inspect against the
OpenCode-created database, L3 rebuild/get, Session Start and Abandon, and a
second independent Claude process proving persistence. An authentication
failure is external evidence, not a RepoMind failure or a passing result.
