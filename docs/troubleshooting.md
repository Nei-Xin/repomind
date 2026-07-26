# Troubleshooting

Start with `repomind doctor --json`. It reports the Node version, SQLite and
FTS5 availability, whether Git resolves a repository root from the current
directory, and whether that repository is initialized.

## Error codes

Every failure returns a stable code, so clients can branch on it rather than
parsing prose.

| Code | Means | Fix |
| --- | --- | --- |
| `REPOSITORY_NOT_INITIALIZED` | no `.repomind/project.json` in the repository root | run `repomind init` there |
| `NOT_A_GIT_REPOSITORY` | the path resolves to no Git root | run inside a repository, or pass `--repo` / `repo_path` |
| `PATH_OUTSIDE_REPOSITORY` | a path escaped the repository root | use a repository-relative path |
| `SESSION_NOT_FOUND` | unknown session ID for this repository | check `repomind sessions`; sessions belong to one repository |
| `SESSION_NOT_OPEN` | the session already ended | start a new one; committed sessions cannot be rewritten |
| `MEMORY_NOT_FOUND` | unknown memory ID for this repository | confirm the ID and the repository it belongs to |
| `INVALID_INPUT` | schema or precondition failure | the `details` field names the offending field or state |
| `GIT_INSPECTION_FAILED` | a read-only Git command failed | check that `git` is on `PATH` and the repository is readable |
| `STORAGE_UNAVAILABLE` | the database could not be opened | check permissions on the data directory |

## Common situations

**The MCP client shows no tools, or the connection fails immediately.** Build
first: the server runs from `dist/`. Then confirm nothing but JSON-RPC reaches
stdout — a stray `console.log` in stdio mode corrupts the protocol. `npm test`
includes a purity check that spawns the real server and rejects any non-JSON
line.

**Tools worked, then started returning `repo_path is required`.** The server
remembers which repository a session or memory came from only for its own
process lifetime. After a restart, pass `repo_path` explicitly on commit and
inspect calls.

**A memory I know exists is not returned by search.** Check its status.
`superseded` and `invalid` memories are excluded from recall by design; inspect
still shows them with their full history. If it is `uncertain`, it is returned
but ranked lower and carries a warning.

**Everything is `uncertain` after a large refactor.** That is the intended
signal, not a fault: the related files changed, so the conclusions need review.
Confirm each one with `repomind memory-validate <id> --reason "..."`, which
re-baselines the file hashes and returns it to `active`. Correct the ones that
are wrong and invalidate the ones that are dead.

**Two memories contradict each other and both are `uncertain`.** Conflict
detection did its job. Validate the side that holds, then correct or invalidate
the other. A correction may itself stay `uncertain` if it still contradicts a
live memory; the result's `conflicts` field names what it clashes with.

**Recording a fact returns `stored: false`.** An identical fact already exists
and the new evidence was attached to it. If the existing memory was retired,
recording it again reactivates it and returns `reactivated: true`.

**A correction fails with "matches memory … which is superseded/invalid".**
The corrected wording collides with a retired memory that still owns that
content fingerprint. Either choose different wording or `repomind forget` the
retired memory first.

**Search feels slow on a large repository.** A staleness refresh runs before
results are returned. It reads each related file at most once and skips hashing
files whose size and modification time are unchanged, so the usual cost is a
`stat` per distinct file. Files touched within the last two seconds are always
re-hashed, which is deliberate: an edit landing in the same filesystem tick can
leave size and mtime identical.

**Windows: `EBUSY` while deleting a temporary directory in tests.** A SQLite
handle is still open. Close every core you open, in a `finally`.

**A session is stuck `open`.** The agent never committed. `repomind sessions`
lists them; `repomind session-abandon <id>` closes one out. An open session
never produces long-term memories, so nothing is silently recorded from it.

## Data location

Memories live in `~/.repomind/repositories/<projectId>/repomind.db`
(`%USERPROFILE%` on Windows), and `REPOMIND_DATA_DIR` overrides the root. To
start clean, delete that project directory; the repository itself only holds
`.repomind/project.json`. To remove a single memory and its exclusively-owned
evidence, use `repomind forget <id> --reason "..." --yes` — the only operation
that physically deletes content.
