# Data export, backup, and restore

RepoMind provides two deliberately separate portability
mechanisms. A logical export moves repository knowledge into another initialized
repository. A physical backup restores the exact SQLite state of the same
Project ID. v0.18 adds opt-in encryption to both archive types while retaining
the existing plaintext formats.

## Logical export format

```powershell
repomind export --output D:\backups\repository.json --json
```

The JSON envelope identifies `repomind-repository-export`, format version 2,
the source Project ID, database schema version, export time, fixed table data,
and a deterministic SHA-256 checksum. RepoMind refuses unknown or missing
tables, unknown or missing columns, unsupported versions, and checksum changes.
The destination file and its parent directory must be explicit; existing files
are never overwritten.

The export contains sessions, Evidence, L1 memories, governance history,
relationships, host-run history, L2 narratives, L3 profiles, L4 Skill
Candidates, their review audit, and all source links. Version 1 exports remain
readable and import with empty L4 tables. It excludes:

- checkout paths, because they belong to one machine;
- FTS tables, because they are rebuilt during import;
- vector embeddings, because they are derived from a configured provider; and
- schema migration bookkeeping, because the target uses its installed schema.

An export requires no open Session or running Host Run. RepoMind scans every
string for known credential patterns. A finding blocks the write by default.
After inspecting and accepting the risk, `--allow-sensitive` records that the
operator explicitly allowed the export. It does not silently alter archive
content. It does not silently alter the exported data.

## Encrypted archives

Set a passphrase in the process environment, then opt in with `--encrypt` when
creating an archive:

```powershell
$env:REPOMIND_ARCHIVE_PASSPHRASE = Read-Host "Archive passphrase" -MaskInput
repomind export --output D:\backups\repository.enc.json --encrypt --json
repomind backup --output D:\backups\repomind.db.enc --encrypt --json
Remove-Item Env:REPOMIND_ARCHIVE_PASSPHRASE
```

The passphrase must contain at least 12 UTF-8 bytes. It has no command-line
form and is never included in command output. To use a secret-manager-specific
variable, add `--passphrase-env MY_ARCHIVE_SECRET`; this flag names the
variable and never contains its value.

The encrypted JSON envelope is `repomind-encrypted-archive` format version 1.
It uses AES-256-GCM with a random 16-byte salt, random 12-byte IV, and 16-byte
authentication tag. The 32-byte key is derived with scrypt (`N=32768`, `r=8`,
`p=1`). Purpose, creation time, plaintext format/version/size/SHA-256, KDF
parameters, salt, cipher, and IV are authenticated as GCM additional data.
The public CLI result reports the algorithm and plaintext metadata but omits
salt, IV, tag, ciphertext, and passphrase.

Import and restore auto-detect the encrypted envelope. They read
`REPOMIND_ARCHIVE_PASSPHRASE` when it exists, or the variable named with
`--passphrase-env`:

```powershell
repomind import --input D:\backups\repository.enc.json --dry-run --json
repomind import --input D:\backups\repository.enc.json --yes --json
repomind restore --input D:\backups\repomind.db.enc --dry-run --json
repomind restore --input D:\backups\repomind.db.enc --yes --json
```

An incorrect passphrase, changed ciphertext or tag, changed authenticated
metadata, or archive-purpose mismatch fails before logical target data or the
live database is written. Encrypted physical backup is one JSON file and has
no sidecar manifest; the authenticated envelope carries its size and hash.
Restore briefly stages decrypted SQLite in an operating-system temporary
directory, requests file mode 0600 where the platform supports POSIX modes,
and removes that directory in `finally` on success or failure.

Encryption protects portable archives at rest. It does not encrypt RepoMind's
live local database or the same-data-directory pre-restore rollback snapshot,
does not hide envelope size and creation metadata, and does not provide key
escrow, rotation, scheduled backup, or cloud storage. Keep the environment and
host process secure and retain the passphrase separately from the archive.

## Logical import

```powershell
repomind import --input D:\backups\repository.json --dry-run --json
repomind import --input D:\backups\repository.json --yes --json
```

Logical import has one unambiguous mode: `replace`. Dry-run validates the
envelope, checksum, table contract, sensitive patterns, schema compatibility,
and active-work guard without changing data. `--yes` deletes the current
repository's logical data and inserts the archive in one SQLite transaction.
A constraint error rolls the entire transaction back.

The source Project ID is retained as provenance in the result, while every
repository and checkout foreign key is mapped to the initialized target. This
allows a reviewed export to seed a different repository without rewriting its
`.repomind/project.json`. Memory, Evidence, Session, L2, L3, and L4 candidate
IDs remain stable. FTS is rebuilt in the same transaction and vectors return
to an empty, rebuildable state.

Merge import is intentionally not implemented. Combining two governed memory
histories requires duplicate, contradiction, audit, and ID-collision policies;
silently treating replacement as merge would make recovery unpredictable.

## Physical backup

```powershell
repomind backup --output D:\backups\repomind.db --json
```

Backup uses SQLite `VACUUM INTO` to produce a consistent standalone database.
It also writes `repomind.db.manifest.json` with format version 1, Project ID,
schema version, byte length, and SHA-256. Neither file may already exist. The
command refuses to snapshot open Sessions or running Host Runs.

Keep the database and manifest together. Editing either makes restore fail.

## Physical restore

```powershell
repomind restore --input D:\backups\repomind.db --dry-run --json
repomind restore --input D:\backups\repomind.db --yes --json
```

Restore requires the backup Project ID to equal the repository marker Project
ID. Use logical import for a different Project ID. Dry-run verifies the
manifest, checksum, SQLite integrity, schema, repository identity, and active
work state.

Confirmed restore stages and migrates a copy beside the live database. Before
replacement, RepoMind creates a checksummed
`repomind.db.pre-restore-<id>.db` snapshot and manifest. It then swaps the
staged database into place and opens it through the normal migration path. If
that validation fails, the displaced live database and its WAL state are put
back automatically.

If the live database itself cannot be opened, restore refuses to guess whether
the cause is corruption, a lock, or another storage failure. After diagnosing
the condition, `--allow-unreadable` explicitly authorizes replacement. RepoMind
copies the unreadable file to a `.pre-restore-<id>.unreadable.db` artifact before
the swap. A missing live database can be restored without this flag.

## Current boundary

This iteration provides local CLI recovery and optional encrypted archives,
not scheduled backups, cloud sync, MCP restore tools, key-management service
integration, or logical merge. Existing plaintext export versions 1 and 2 and
backup format 1 remain compatible.
