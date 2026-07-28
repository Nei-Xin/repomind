# RepoMind v0.7 agent benchmark infrastructure acceptance

This document records deterministic acceptance of the v0.7 three-arm benchmark
infrastructure. It does not claim model-outcome success. The completed formal
report-v4 run is documented separately in
[`agent-benchmark-results-v0.7.md`](agent-benchmark-results-v0.7.md); its
integrity passed, but its predeclared outcome acceptance failed.

## Provenance

| Field | Value |
| --- | --- |
| Date | `2026-07-28` (Asia/Shanghai) |
| RepoMind base commit | `d857056d8229796398f5f222fec29e7ea5540320` |
| Worktree | dirty v0.7 candidate |
| Node.js | `v22.20.0` |
| Operating system | Windows `win32 10.0.26200 x64` |
| Manifest template SHA-256 | `13ed7a5eba633b94eec84403abf8103f580607ebc6b4b46b999ed9c2793c2f74` |

## Accepted capabilities

- Manifest v1 remains a two-arm protocol; manifest v2 requires raw
  `fullHistory` for every task and runs three arms.
- Three-arm execution order rotates across repetitions using a Latin square.
- The full-history arm has no RepoMind MCP configuration.
- Report schema v4 computes separate RepoMind comparisons against no-memory and
  full-history baselines.
- Acceptance gates can constrain hidden-check and duration deltas against both
  baselines.
- `agent-summary` hashes source reports and recomputes aggregate paired metrics
  with approximate 95% intervals.
- The shipped suite deterministically rebuilds eight Git repositories.

## Fixture baseline validation

| Task | Base commit | Public baseline | Hidden baseline |
| --- | --- | --- | --- |
| `renamed-module` | `14a35ca67e878584b3b2ae35a621b961eda7fe8a` | passed | failed as designed |
| `failed-solution` | `565512aae51d6108774068ebee7fa81c8eedfd2f` | passed | failed as designed |
| `migration-rollback` | `bd7d5c00612d70852c1814205538911eb556ca59` | passed | failed as designed |
| `historical-command` | `76c1ded92559e909ba05933bfece3b77860e272d` | passed | failed as designed |
| `stale-endpoint` | `059a83f5e2b35a32aa2f4ffae5a7621913b57ebc` | passed | failed as designed |
| `error-contract` | `e10f1e5c09ffdbcc06c855851855e08b275bc658` | passed | failed as designed |
| `dependency-boundary` | `db16b57646fa71bd631c6a1620439dc5459b538c` | passed | failed as designed |
| `config-default` | `4e7df231c78977289150e45984ae5a27ee317fa8` | passed | failed as designed |

The same-template double-generation test also requires every base commit to be
identical across two independent output directories.

## Limits

- All eight shipped tasks are small JavaScript fixtures designed by RepoMind's
  authors. The larger suite improves coverage, not external validity.
- Windows validation was run locally. Ubuntu validation is enforced by CI and
  should be checked on the release commit before interpreting portability as
  demonstrated.
- No OpenCode/model outcome is represented by this infrastructure document.
  Outcome metrics and their failed formal acceptance are recorded only in the
  separate v0.7 results document.
- The reported 95% intervals use a normal approximation over paired deltas;
  small samples must be interpreted cautiously.
