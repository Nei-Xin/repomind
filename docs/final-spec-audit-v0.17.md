# RepoMind v0.17 final-spec audit

## Outcome

All 28 criteria in section 24 of `REPOMIND_FINAL_PRODUCT_SPEC.md` now have
implementation and retained acceptance evidence. The last open product-proof
criterion, an external real-open-source cross-session benefit case, passed
after the v0.17.0 release. This audit records evidence completeness; it does not
rename v0.17.0 as v1.0.

The detailed 27-row implementation audit remains in
`docs/final-spec-audit-v0.16.md`. Its then-open row is superseded as follows:

| Criterion | Evidence | Status |
| --- | --- | --- |
| External real open-source cross-session benefit | `docs/external-open-source-cross-session-acceptance-v0.17.md`: fixed `p-limit` commit, Claude Code Task 1, three paired OpenCode no-memory/RepoMind repetitions, external hidden checks, raw events and hashes | Complete |

## Evidence boundary

The external result keeps success and efficiency separate. Both arms passed all
public and hidden checks. RepoMind then demonstrated lower input Tokens and
Agent duration in every pair. The report retains the original negative runner
summary and its no-rerun corrected analysis, so the proof does not hide the
known upstream test failure or reinterpret a failed task outcome as success.

The following remain deliberate non-gates rather than missing section-24
criteria:

- logical Merge Import, pending an identity, conflict, replacement, Evidence,
  Audit, and L2-L4 policy;
- opt-in encrypted export and backup archives;
- automatic observation of Agent host tools; and
- automatic installation or execution of L4 Skill Candidates.
