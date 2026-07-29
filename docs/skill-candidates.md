# L4 Skill Candidates

RepoMind v0.15 adds the final memory layer from the product model:
reviewable workflow candidates derived from repeated successful repository
work. A candidate is evidence-backed knowledge, not executable automation.

## Generation contract

Run:

```bash
repomind skill-rebuild --json
```

The default generator requires at least three distinct Sessions. A Session is
eligible only when it is `committed` and contains at least one successful
`command_result` or `test_result`. The generator groups Sessions by their
normalized successful command and test sets. Matching is deliberately strict
and deterministic; v0.15 does not claim to infer semantically equivalent
natural-language workflows.

These inputs never qualify:

- `partial`, `failed`, or `abandoned` Sessions;
- successful Sessions without command or test Evidence;
- workflows observed in fewer than three successful Sessions; and
- workflows whose successful command or test sets differ.

Each candidate contains a trigger, generic inputs, ordered steps,
verification commands, observed failures as risks, and direct links to every
source Session and Evidence record. Rebuilding unchanged sources is a no-op.
When another matching Session appears, the candidate is updated and any prior
approval is reset to `pending`.

## Human review

```bash
repomind skills --status pending --json
repomind skill-inspect l4_... --json
repomind skill-review l4_... --action approve --reason "Reviewed commands, verification, and risks" --json
```

Candidate states are:

```text
generated -> pending
pending -> approved
pending -> rejected
approved/rejected -> pending  (source set changed)
```

Every transition is audited. A review reason is mandatory and is passed
through the same secret-redaction rules as other long-term data. A reviewed
candidate cannot be reviewed again until new sources reopen it.

## Safe export

```bash
repomind skill-export l4_... --output ./review/SKILL.md --json
```

Export is allowed only for `approved` candidates. The output must be a new
`.md` file in an existing directory. RepoMind refuses to overwrite a file,
redacts secret patterns and absolute paths, writes a SHA-256 into the audit
record, and removes the output again if audit persistence fails.

The exported document includes standard skill frontmatter plus Inputs, Steps,
Verification, Risks, and Provenance sections. Export does not copy the file to
an Agent configuration directory, register it with a client, install it, or
execute any command. Those remain explicit user-controlled actions outside
RepoMind.

## MCP tools

The same semantics are available through:

- `repo_skill_candidate_rebuild`
- `repo_skill_candidate_list`
- `repo_skill_candidate_inspect`
- `repo_skill_candidate_review`
- `repo_skill_candidate_export`

Candidate IDs are repository-scoped. After an MCP restart, pass `repo_path`
for inspect, review, and export calls.

## Current limits

The deterministic signature favors precision and auditability over recall. It
will not merge aliases such as `npm test` and `npm run test`, reorder a
multi-step procedure semantically, infer missing inputs, or ask a remote model
to synthesize prose. Those are evaluation inputs for the future remote LLM
adapter, not reasons to weaken the v0.15 evidence gate.
