# RepoMind v0.16 final-spec audit

## Outcome

This audit reconciles section 24 of `REPOMIND_FINAL_PRODUCT_SPEC.md` with the
implementation and retained evidence after v0.16.0. Twenty-seven of the 28
criteria have executable evidence. One product-proof criterion remains open:
a continuous-task benefit study on an external real open-source repository.

An implemented feature is not counted only because source code exists. Each
completed row below points to a test, a rebuildable runner, a formal report, or
cross-platform CI. This audit does not rename v0.16.0 as v1.0.

## Product capability

| Criterion | Evidence | Status |
| --- | --- | --- |
| Real Git repository initialization and operation | `tests/e2e.test.ts`, L2/L3 real-repository reports | Complete |
| At least two MCP Agent hosts | `docs/quality-and-cross-agent-v0.13.md`, `docs/l4-cross-agent-acceptance-v0.15.md` | Complete |
| Start -> Recall -> Commit -> Extract | `tests/e2e.test.ts`, `docs/remote-extraction-acceptance-v0.16.md` | Complete |
| Recall across processes and Agents | CLI E2E and v0.16 Claude Code -> OpenCode acceptance | Complete |
| L0-L3 data flow | `docs/l2-real-repository-acceptance-v0.12.md`, `docs/l3-real-repository-acceptance-v0.12.md` | Complete |
| Review-required L4 Candidate | `docs/skill-candidate-acceptance-v0.15.md` | Complete |
| Search, inspect, record, correct, validate, forget | governance and E2E tests | Complete |
| FTS/vector hybrid with fallback | `tests/vector.test.ts`, `docs/vector-search.md` | Complete |
| Status, conflict, replacement, audit | governance, conflict, reactivation, and forget tests | Complete |

## Trustworthiness

| Criterion | Evidence | Status |
| --- | --- | --- |
| Automatic memories bind Evidence | deterministic and remote extraction tests | Complete |
| Inspect explains provenance and state | CLI/MCP E2E and cross-Agent reports | Complete |
| File changes detect staleness | stale detection and performance tests | Complete |
| Weak inference cannot overwrite stronger facts | conflict and remote-validation tests | Complete |
| Conflicts are not silently merged | conflict tests and conservative remote deduplication | Complete |
| Correction/deletion remain auditable | review, correction, forget, and reactivation tests | Complete |

## Engineering quality

| Criterion | Evidence | Status |
| --- | --- | --- |
| Windows, Linux, macOS CI | v0.16 main and tag CI runs | Complete |
| Core, SQLite, MCP, E2E | 167-test v0.16 regression suite | Complete |
| Every published Schema upgrades | locked release manifest and Migration fixture tests | Complete in v0.17 worktree |
| MCP stdout protocol purity | `tests/mcp-stdio.test.ts` | Complete |
| Database, LLM, Embedding failure behavior | Migration rollback, remote atomic-failure, and FTS fallback tests | Complete |
| Retrieval performance | `docs/scale-acceptance-v0.14.md` | Complete |
| Security and Secret Redaction | security, redaction, portability, and remote acceptance tests | Complete |

## Project proof

| Criterion | Evidence | Status |
| --- | --- | --- |
| Rebuildable Demo repositories and scripts | eight-task generator and acceptance runners under `benchmarks/` | Complete |
| No-memory, flat retrieval, RepoMind comparison | comparison and three-arm Agent benchmarks | Complete |
| Success, Token, repeated exploration, stale misuse | v0.7-v0.8 reports and phase profiler | Complete |
| Host observation limitation documented | architecture, daily workflow, MCP integration docs | Complete |
| README, architecture, ADR, contribution guide | repository documentation and ten ADRs | Complete |
| External real open-source cross-session benefit | Current real-repository tests use RepoMind itself; cross-Agent task repositories are controlled fixtures | Open |

## Explicit non-gates

- Logical Merge Import is intentionally absent because governed IDs, Evidence,
  conflicts, and replacement relations require a separately specified merge
  policy. Replace import satisfies the current portability contract.
- Encrypted archives remain a valuable security enhancement, but section 24's
  local recovery requirement is already met by checksummed backup and restore.
- Provider currency cost is not claimed without a stable provider price
  schedule. Formal reports retain provider-reported Token usage.
- RepoMind does not install or execute L4 Skills and does not automatically
  observe host tools. These remain product safety boundaries, not missing Agent
  features.
