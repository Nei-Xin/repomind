# RepoMind v0.12 real-repository L3 acceptance

Date: 2026-07-28

Integrity: **passed**

## Method

The rebuildable runner cloned the real RepoMind repository at fixed commit
`051212de0e167c4a2c24addace85f1c535decb67` into an isolated workspace under
`D:\data\code\project\repomind-test`. It used an isolated RepoMind data
directory and did not read or mutate the developer's daily memory database.

The runner seeded 13 reviewed module L1 facts from the L2 acceptance manifest,
built six real L2 module boundaries, and added three reviewed repository-level
facts. It then exercised initial L3 generation, provenance inspection,
unchanged rebuild, low-confidence repository and module changes, an eligible
source change, stale-profile Session Start, versioned rebuild, current-profile
Session Start, and repeated latency sampling. The final corpus contained 19 L1
memories, six L2 module sources, four repository L1 profile sources, and two L3
versions.

Rebuild with a new output directory:

```powershell
npm run bench:l3-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\l3-real-<new-id> `
  --repeat 50
```

Manifest SHA-256:
`f03b002939efd3a846ab49514d1ac518ba98c75ff0aed4c5a84612e77bf80bdd`.

The raw JSON and generated Markdown are retained at
`D:\data\code\project\repomind-test\l3-real-v0.12-20260728`.

## Environment

| Field | Value |
| --- | --- |
| OS | Windows `10.0.26200` |
| Node.js | `v22.20.0` |
| CPU | AMD Ryzen 7 H 255 w/ Radeon 780M Graphics |
| Logical CPUs | 16 |
| Memory | 33,068,818,432 bytes |
| L3 character budget | 6,000 |
| Minimum confidence | 0.8 |

## Functional checks

All 15 gates passed:

- all reviewed L1 inputs were stored and six real L2 boundaries were built;
- the initial current profile stayed inside its hard character budget;
- the profile contained repository L1 and L2 module sources;
- every live source traced to evidence-backed L1;
- an unchanged rebuild retained version 1;
- low-confidence repository and module changes did not stale or rebuild L3;
- an eligible source change made L3 stale;
- stale L3 was not injected into Session Start;
- rebuild produced current version 2 and retained both versions;
- current L3 was injected into Session Start; and
- all four latency gates passed.

The automated test suite separately verifies that a new high-confidence module
L1 makes L3 stale before L2 is rebuilt and that each retained L3 version stores
the exact repository and module L1 source IDs used to create it.

## Latency

| Operation | Samples | P50 ms | P95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Rebuild, unchanged | 50 | 3.763 | 5.204 | 6.016 |
| Get and freshness check | 50 | 3.799 | 5.014 | 5.805 |
| Inspect provenance and versions | 50 | 3.981 | 5.630 | 6.203 |
| Session Start with current L3 | 30 | 189.922 | 210.615 | 264.485 |

## Limits

- The target is a real repository, but reviewed deterministic L1 inputs do not
  test remote LLM extraction quality.
- The corpus is repository-sized. It does not prove the final 10,000-L1
  performance target.
- Results are from one Windows machine and do not prove macOS compatibility or
  generalize to other hardware.
- This run does not prove interoperability with a second real Coding Agent,
  export/import or backup/restore, coverage targets, L4 Skill Candidates, or
  remote LLM behavior.
