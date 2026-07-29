# RepoMind v0.18 encrypted portability

## Goal

v0.18 protects logical exports and physical backup files when they leave the
normal RepoMind data directory. It extends the existing replace-import and
same-Project-ID restore contracts; it does not change them or introduce Merge
Import.

The implementation uses a strict `repomind-encrypted-archive` version 1 JSON
envelope, AES-256-GCM authenticated encryption, and scrypt with `N=32768`,
`r=8`, `p=1`, and a 32-byte key. Every archive gets a random 16-byte salt and
12-byte IV. The purpose and plaintext format, version, byte length, and SHA-256
are authenticated metadata. A passphrase must contain at least 12 UTF-8 bytes.

## Credential boundary

The CLI never accepts a passphrase value as an argument. `--encrypt` reads
`REPOMIND_ARCHIVE_PASSPHRASE`; `--passphrase-env <name>` selects another
environment variable. Import and restore automatically use the default
variable when present. Core library callers pass an in-memory `passphrase`
option and remain responsible for acquiring and clearing it.

Passphrase values, salts, IVs, tags, and ciphertext are omitted from operation
results and acceptance reports. The archive itself necessarily contains the
salt, IV, tag, and ciphertext. RepoMind does not persist or recover passwords.

## Failure contract

Logical decryption and envelope validation happen before the SQLite replace
transaction. Physical decryption and authenticated metadata validation happen
before a temporary SQLite file is created. Wrong passwords, modified
ciphertext or tags, modified authenticated metadata, and purpose mismatch must
therefore leave the target repository unchanged.

Encrypted restore writes decrypted SQLite only to a newly created
operating-system temporary directory, requests mode 0600 where POSIX modes are
supported, and recursively removes that directory in `finally`. The live
database and its persistent pre-restore
rollback snapshot remain plaintext local storage; archive encryption is not
full-disk encryption.

## Rebuildable acceptance

Run from a clean RepoMind commit with a fresh external workspace:

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Acceptance passphrase" -MaskInput
npm run bench:encrypted-portability -- `
  --repo D:\data\code\project\repomind `
  --workspace D:\data\code\project\repomind-test\v018-encrypted-<new-id> `
  --repeat 5 `
  --require-clean
Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

The runner refuses an existing workspace. It clones the selected commit twice,
uses an isolated data directory, seeds deterministic L1-L3 repository data,
and measures plaintext and encrypted export, import, backup, and restore. Its
gates cover format compatibility, complete round trips, known-plaintext
absence, wrong-password rejection, ciphertext/tag/AAD/purpose tampering,
zero-write behavior, single-file encrypted backup, temporary plaintext cleanup,
and report credential exclusion.

JSON and Markdown reports retain the implementation commit, dirty state,
cloned data commit, operating system, hardware, artifact hashes, dataset sizes,
raw timing samples, percentiles, and measured encryption overhead. A formal
release result must use `--require-clean`; a dirty development run is useful
for diagnosis but is not release evidence.

The existing `bench:package-smoke` runner also exercises encrypted export,
import, backup, and restore through the installed npm tarball. It generates a
fresh in-process passphrase, passes it only through the child environment, and
checks that package reports omit it. The normal three-platform CI matrix runs
this installed-package proof on Ubuntu, Windows, and macOS.

## Formal clean-commit result

The formal Windows run passed all 29 gates on 2026-07-29 against clean commit
`bcf88224d52ac362a07d98a22e920f78c2a6f4c4`. The report records
`implementationDirty=false` and `requireClean=true`. Its deterministic dataset
contains 40 L1 Memories, two L2 narratives, and one L3 profile.

The five-sample P50 encryption overhead on this machine was 93.267 ms for
logical export, 96.09 ms for logical import dry-run, 106.503 ms for physical
backup, and 159.485 ms for physical restore dry-run. The plaintext/encrypted
sizes were 106,069/142,027 bytes for logical export and 462,848/617,723 bytes
for physical backup. These are single-machine measurements, not universal
performance targets.

Artifacts are retained outside the repository at:

```text
D:\data\code\project\repomind-test\v018-encrypted-portability-formal-bcf8822-01
```

- JSON report SHA-256:
  `a21a9245b22589cf188c16f772fb1b0b8327865be9a5e6a6e21d701db4b77946`
- Markdown report SHA-256:
  `47824976a916b9471a5aa8f4308886aad3857907daab439e6df317af6072b827`

## Clean-commit cross-platform result

[GitHub Actions run 30464400835](https://github.com/Nei-Xin/repomind/actions/runs/30464400835)
completed successfully against `bcf8822` in 7 minutes 4 seconds. Ubuntu,
Windows, macOS, source coverage, and the comparison benchmark all passed. Each
platform ran typecheck, build, the complete test suite, Agent fixture checks,
and the 14-gate installed-tarball smoke, including encrypted logical and
physical portability with a generated environment-only passphrase.

The five Actions warnings are upstream Node.js 20 deprecation notices for
GitHub-maintained actions that GitHub forced onto Node.js 24. They did not
represent a RepoMind test, package, or runtime failure.

## Remaining boundary

This iteration does not add Merge Import, automatic schedules, remote upload,
cloud synchronization, hardware-backed keys, key rotation, key escrow, MCP
restore tools, or encryption of the live local database. Those require
separate policies and threat models.
