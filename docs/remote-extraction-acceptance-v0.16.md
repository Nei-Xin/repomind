# RepoMind v0.16 remote extraction acceptance result

## Outcome

The clean-commit live acceptance passed all 13 gates on 2026-07-29 using the
OpenAI-compatible endpoint origin `https://sub2api.zzii.de` and model
`gpt-5.6-terra`. The target checkout and implementation were fixed at commit
`eae96bcc78e2cc4b30bf9048cd1ae8ec2296d7e2`, and the report records
`sourceWorktreeDirty: false`.

The API credential existed only in the acceptance process environment. It was
removed when the process ended and is absent from Git, fixtures, stdout, and
both reports. The runner also scanned the serialized JSON and would have
refused to write it if the credential value appeared.

## Results

| Metric | Result | Gate |
| --- | ---: | ---: |
| Positive-scenario recall | 1.000 | at least 0.800 |
| Candidate precision | 1.000 | at least 0.750 |
| Empty/injection accuracy | 1.000 | exactly 1.000 |
| Current-Session Evidence binding | 1.000 | exactly 1.000 |
| Extraction Audit binding | 1.000 | exactly 1.000 |
| Latency P50 | 9,565 ms | recorded |
| Latency P95 | 12,669 ms | less than 120,000 ms |
| Input tokens | 7,584 | provider reported |
| Output tokens | 1,083 | provider reported |

The six positive facts produced one relevant candidate each. The independent
repeat produced one candidate but stored no second Memory; it linked new
Evidence and Audit provenance to the existing confidence-policy Memory. The
cosmetic and Prompt Injection Sessions both returned empty candidate batches.
Malformed output, fabricated Evidence, and cancellation all rejected with zero
Memory, Evidence-link, or Audit writes. SQLite integrity returned `ok`, foreign
keys had no violations, and no Session remained open.

Manual review found the following candidate labels and titles appropriate for
their controlled Evidence:

| Scenario | Type | Title |
| --- | --- | --- |
| Storage transaction | `architecture` | Storage transaction boundary |
| MCP stdout | `requirement` | Reserve stdout for MCP JSON-RPC |
| Two-phase extraction | `decision` | Run remote extraction after commit |
| Validated output | `decision` | Validate model candidates before persistence |
| Remote privacy | `requirement` | Remote extraction privacy boundary |
| Confidence cap | `requirement` | Cap remote extraction confidence at 0.9 |

## Acceptance-driven fix

The first clean live run targeted acceptance-runner commit
`e3cb54ef6a3380a6020f1dfe31141328911e20e4`. Quality, empty-result, Evidence,
Audit, safety, latency, usage, and database gates all passed, but overall
acceptance failed because the repeated fact was classified first as `decision`
and then as `requirement`, with minor wording drift. Exact type/content
fingerprinting stored two semantically equivalent Memories.

Commit `eae96bc` added conservative cross-run equivalence: title and scope must
match exactly, normalized content similarity must be high, and number sets and
negation must agree. Changed limits and opposite claims remain distinct. The
second live run then deduplicated the repeated candidate and passed all gates.
The failed run is retained because it demonstrates that the runner found a
real product defect rather than merely confirming its own fixture.

## Provenance

Artifacts are retained outside the repository:

```text
D:\data\code\project\repomind-test\v016-remote-live-eae96bc
```

- JSON report SHA-256:
  `f2267d7ceef9acf960e6bba97c3a48d1ef78018ab9c7dd089cb2e793a068f71d`
- Markdown report SHA-256:
  `c32e8fec6783fbb891893f8b500f9ef1f3a4dfb02ccb302551994affe412b383`
- Dataset SHA-256 recorded by the report:
  `f477202cad5b9a907e11f3bfb367b079084faaa85b1d41521aa8ac74a3390c88`
- Runner SHA-256 recorded by the report:
  `eabc210759ab4f5334deb97818f27f86ca21f78ab9ba22d6fcd7331e1328a80a`

The failed first-run artifacts are retained at
`D:\data\code\project\repomind-test\v016-remote-live-e3cb54e`; its JSON report
SHA-256 is
`5f98aa7885c87eacf6bbf30ed8b87b2744c35a569ac938c38d2d75fd2246cc09`.

The passing run used Node.js 22.20.0 on Windows 10.0.26200 with an AMD Ryzen 7
H 255 processor. It completed nine remote calls in 101.6 seconds including
build, clone, Session setup, local probes, and reporting.

## Limits

This proves the stated quality and safety gates for one model, endpoint,
controlled dataset, machine, and run. It does not prove provider
confidentiality or universal repository quality. The endpoint reported token
usage but no price schedule was supplied, so this result does not claim a
currency cost. A real Claude Code/OpenCode continuous-task acceptance and
cross-platform CI remain required before v0.16.0 release.
