# RepoMind 1.0.0-rc.2 pre-release engineering audit

Date: 2026-08-12 (Asia/Shanghai)

Base commit: `ba5f55772000a50ec21678fc5bd6e0721ef2cbbb`

## Decision

The local release candidate is accepted for commit, annotated tagging, and
GitHub prerelease publication. Storage remains at Schema 11 and no Migration,
logical export, backup, or encrypted-envelope format changed.

Publication by the unscoped npm name is explicitly rejected. The public npm
package `repomind@1.4.0` belongs to `repomind-dev/repomind` and another
maintainer, and this machine has no npm authentication. RC.2 is therefore
distributed as a versioned npm tarball attached to the project-owned GitHub
Release, with a SHA-256 checksum.

## Findings and corrections

| Severity | Finding | Correction | Verification |
| --- | --- | --- | --- |
| Release blocker | `repomind --version` was rejected by `parseArgs` and printed a Node stack | Added `--version`/`-v`, concise parse errors, and a lightweight CLI entry | Cross-process E2E and installed-package smoke |
| Release blocker | README only documented checkout development with `npm link` | Added GitHub Release installation, version verification, initialization, Agent diagnostics, and source-install separation | Installed tarball used in a fresh consumer |
| High | `doctor` did not verify OpenCode or Claude and a missing runner was discovered only after lifecycle start | Added selected/all Agent version probes and a preflight before Session creation | Missing executable returns `CAPABILITY_UNAVAILABLE`; open Sessions remain zero |
| High | The npm package name is owned by another project | Prohibited by-name npm installation and npm publication; release through the repository's GitHub artifact | `npm view repomind` ownership audit and README warning |
| Medium | The runtime tarball included benchmark sources, hidden validators, and fixture repositories | Removed `benchmarks` from the published file allowlist | Package boundary check; file count reduced from 337 to 236 |
| Medium | Release assets had no automated tag publication path | Added a tag-triggered release workflow with full local gates, `.tgz`, and `SHA256SUMS` upload | Workflow syntax and local equivalents reviewed; tag run remains the independent remote gate |

## Commands and results

Environment:

```text
node --version  -> v22.20.0
npm --version   -> 11.16.0
git --version   -> git version 2.51.0.windows.1
```

Package ownership audit:

```text
npm view repomind name version dist-tags repository maintainers --json
-> repomind@1.4.0
-> git+https://github.com/repomind-dev/repomind.git
-> maintainer gilbert-dev

npm whoami
-> ENEEDAUTH
```

Local engineering gates:

```text
npm run typecheck
-> passed

npm run build
-> passed

npm test
-> passed: 266 tests across 46 files

npm run bench:agent-fixtures
-> passed: 8/8 deterministic task baselines

npm run bench:cross-session-agent-fixtures
-> passed: 6 same-Agent sequences and 2 cross-Agent directions

npm run bench:layered-consumption-fixtures
-> passed: 3/3 three-stage derived-only sequences with L1 disabled at consumption

npm run bench:package-smoke -- --workspace D:\data\code\project\repomind-test\v100-rc2-package-final-20260812-0047
-> accepted: 17/17 checks
```

The first full `npm test` attempt was intentionally not counted: it was run in
parallel with three repository-rebuilding validators and Vitest reported two
worker RPC `onTaskUpdate` timeouts after assertions completed. Running the
unchanged suite alone produced the authoritative zero-exit result above. No
real Agent/model experiment was rerun for this release audit.

## Installed artifact

```text
Package: repomind@1.0.0-rc.2
Filename: repomind-1.0.0-rc.2.tgz
Compressed bytes: 316476
Unpacked bytes: 1561289
Files: 236
SHA-256: 7335b47a34fd5d706a47550f86c14548321508bd37115fef46ef749ec5cd838d
Forbidden files: 0
MCP tools exercised: 24
Open Sessions after smoke: 0
```

Local evidence is retained outside the repository at:

```text
D:\data\code\project\repomind-test\v100-rc2-package-final-20260812-0047
```

## Remaining remote gates

After the release commit is pushed, create and push the immutable annotated
tag `v1.0.0-rc.2`. The ordinary CI matrix must pass on Ubuntu, Windows, and
macOS. The tag-triggered Release workflow independently repeats typecheck,
build, regression, fixtures, and installed-package smoke before publishing the
tarball and `SHA256SUMS`. A failed remote gate leaves the tag immutable and
requires a later release candidate; it must never be moved.
