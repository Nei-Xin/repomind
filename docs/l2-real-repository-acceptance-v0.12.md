# RepoMind v0.12 real-repository L2 acceptance

Date: 2026-07-28

Integrity: **passed**

## Method

The rebuildable runner cloned the real RepoMind repository at fixed commit
`fb3d133bbfb8548280c88d3e92fa896e2c5e71b8` into an isolated workspace under
`D:\data\code\project\repomind-test`. It used an isolated RepoMind data
directory and did not read or mutate the developer's daily memory database.

The reviewed manifest seeded 13 evidence-backed L1 facts across six real source
modules. The runner performed an initial full build, provenance inspection,
unchanged rebuild, one-source mutation, stale-module check, targeted rebuild,
FTS recall, Session Start recall, and repeated latency sampling. The final
corpus contained 14 L1 memories and six L2 narratives.

Rebuild with a new output directory:

```powershell
npm run bench:l2-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\l2-real-<new-id> `
  --repeat 50
```

Manifest SHA-256:
`f03b002939efd3a846ab49514d1ac518ba98c75ff0aed4c5a84612e77bf80bdd`.

## Environment

| Field | Value |
| --- | --- |
| OS | Windows `10.0.26200` |
| Node.js | `v22.20.0` |
| CPU | AMD Ryzen 7 H 255 w/ Radeon 780M Graphics |
| Logical CPUs | 16 |
| Memory | 33,068,818,432 bytes |
| L2 character budget | 4,000 |

## Functional checks

All checks passed:

- every manifest memory was stored;
- at least six real modules produced narratives;
- all initial and final narratives were current;
- every narrative stayed inside the hard content budget;
- every L2 source traced to L1 and at least one Evidence ID;
- an unchanged rebuild produced no new version;
- adding a storage L1 made only `src/storage` stale;
- targeted rebuild updated exactly that module;
- FTS returned storage context for a migration query; and
- Session Start returned relevant current L2 context.

## Latency

| Operation | Samples | P50 ms | P95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Full rebuild, unchanged | 50 | 3.574 | 4.712 | 5.301 |
| Targeted rebuild, unchanged | 50 | 3.484 | 4.795 | 5.651 |
| List | 50 | 3.011 | 4.391 | 4.555 |
| Search | 50 | 2.833 | 4.070 | 4.327 |
| Inspect | 50 | 2.876 | 3.742 | 4.605 |
| Session Start | 30 | 185.767 | 252.765 | 256.685 |

## Limits

- The target is a real repository, but the reviewed L1 facts are deterministic
  inputs. This does not test remote LLM extraction quality.
- The corpus is repository-sized. It does not prove the final 10,000-L1
  performance target.
- Results are from one Windows machine and cannot be generalized to other
  operating systems or hardware.
- This acceptance proves the L2 layer. It does not prove L3, cross-Agent MCP
  compatibility, export/restore, macOS CI, L4, or remote LLM behavior.
