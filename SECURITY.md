# Security

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Nei-Xin/repomind/security/advisories/new).
Please do not open a public issue for an unpatched vulnerability. Include the
version, platform, and a reproduction if you have one.

## Threat model

RepoMind is a single-user local tool. It reads a Git repository, stores derived
knowledge in a SQLite database under the user's home directory, and serves that
knowledge to whichever coding agent connects over MCP.

The security properties it aims to hold:

- **Untrusted repository content.** Task text, diffs, command output, and test
  summaries are treated as data, never as instructions. RepoMind executes
  nothing it reads.
- **Bounded Git access.** Only a fixed set of read-only Git commands runs, with
  timeouts and output caps. No user or model input is spliced into Git
  arguments. RepoMind never commits, pushes, checks out, resets, or cleans.
  See [ADR-010](docs/adr/ADR-010-read-only-git-commands.md).
- **Repository boundary.** Every file path is resolved and rejected if it lands
  outside the repository root.
- **Repository isolation.** Every query and write carries a repository ID; one
  repository's memories can never surface in another. A benchmark scenario
  asserts this.
- **Local by default.** No telemetry, no network calls, no automatic upload of
  code or diffs. The database stays on the machine that created it.
- **Secret redaction.** Content entering long-term storage passes through
  deterministic redaction that replaces recognized secrets with a visible
  `[REDACTED:kind]` marker, and diff capture excludes sensitive paths outright.

## Known limitations

Redaction is pattern-based, so treat it as defense in depth rather than a
guarantee:

- A secret in a shape no rule recognizes (an unusual internal token format, a
  high-entropy string with no keyword nearby) will be stored verbatim.
- Redaction runs at write time. Data captured by an earlier version is not
  retroactively cleaned; use `repomind forget` to remove it, which physically
  deletes the memory and any evidence only it referenced.
- Sensitive-path exclusion covers common cases (`.env*`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`). Project-specific
  secret locations are not known to RepoMind.
- If you configure the optional remote embedding provider, redaction is what
  stands between memory titles/content and that provider. Evidence bodies and
  Git diffs are not sent for embedding. Review the redaction limits and your
  provider's retention policy before enabling one.

## Verifying

`npm test` includes redaction tests asserting that secrets do not survive in
evidence content, evidence metadata, session tasks, memory fields, the FTS
index, governance audit entries, or the forget tombstone, and that
`repo_memory_inspect` output stays clean.
