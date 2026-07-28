# RepoMind v0.13 real-repository recovery acceptance

## Result

The fixed-commit recovery drill passed every functional and latency check on
2026-07-28. The raw report and all recovery artifacts are stored outside the
repository at:

```text
D:\data\code\project\repomind-test\v0.13-real-recovery-20260728-01
```

The runner cloned RepoMind commit
`97f9816c0d397af89937ada1a8386728b1b8f644` twice and used an isolated
`REPOMIND_DATA_DIR`. The source contained 15 L1 memories, 15 Evidence records,
10 L2 Module Narratives, and one L3 Repository Profile. Logical import used a
different Project ID; physical restore retained the source Project ID.

## Recovery checks

- A versioned logical export reloaded with the same SHA-256 checksum.
- Dry-run and confirmed replace-import preserved L1 IDs and L2/L3 provenance,
  rebuilt FTS, removed target-only data, and left the vector cache empty.
- A physical backup and manifest passed checksum, size, schema, and Project ID
  validation.
- Dry-run and confirmed restore removed a post-backup mutation and retained a
  checksummed pre-restore snapshot on every repetition.
- A modified backup was rejected without changing the recovered database.
- An unreadable live database was rejected until explicit approval; approved
  recovery retained the unreadable input and produced a readable database.

## Performance

Each operation was repeated ten times on the recorded Windows host.

| Operation | P50 ms | P95 ms | Max ms |
| --- | ---: | ---: | ---: |
| Logical export | 4.940 | 7.385 | 7.385 |
| Logical import dry-run | 5.173 | 10.525 | 10.525 |
| Logical import confirmed | 8.469 | 10.982 | 10.982 |
| Physical backup | 8.043 | 10.465 | 10.465 |
| Physical restore dry-run | 63.570 | 73.421 | 73.421 |
| Physical restore confirmed | 80.076 | 94.046 | 94.046 |

Run the acceptance in a new directory with:

```powershell
npm run bench:portability-real -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\<new-directory> `
  --commit <full-commit> `
  --repeat 10
```

These results prove recovery behavior only at the current repository-sized
dataset. They do not prove the final 10,000-L1 target, remote LLM extraction,
logical merge, encrypted archives, or performance on other hardware.
