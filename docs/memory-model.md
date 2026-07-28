# Memory model

RepoMind separates raw evidence from reusable conclusions, and layers
conclusions by how much abstraction they carry. Only the first two layers exist
today; the rest are recorded here because the layering shapes what is safe to
build next.

## L0 — Evidence

Evidence is what actually happened, captured with as little interpretation as
possible. Nine kinds are stored today:

| Kind | Source |
| --- | --- |
| `user_requirement` | the task text passed to `repo_session_start` |
| `agent_summary` | what the agent reported at commit |
| `git_snapshot` | branch, HEAD, dirty state, porcelain status at baseline and final |
| `git_diff` | bounded diff between baseline and final, sensitive paths excluded |
| `test_result` | command, exit code, and summary |
| `command_result` | command, exit code, and summary |
| `manual` | a fact a person recorded directly |
| `validation` / `correction` / `invalidation` | the reason given for a governance action |

Evidence is immutable once referenced. Corrections create new records rather
than editing history, so an audit trail can never be rewritten by a later
claim. Size limits and secret redaction apply on the way in; over-limit content
keeps a hash, a truncation marker, and its origin rather than being dropped
silently.

Evidence is never returned as recall text. It is what you consult to decide
whether to believe a memory, which is a different job from being context.

## L1 — Atomic memories

An L1 memory states exactly one reusable fact about the repository. It is the
unit that search returns and the unit that governance acts on.

| Type | States | Example |
| --- | --- | --- |
| `architecture` | structure or responsibility | HTTP routes are registered only in `src/routes` |
| `convention` | a project rule | public APIs export explicit types |
| `decision` | a choice and its reason | SQLite is the local source of truth |
| `command` | a verified command | `npm test -- storage` runs the storage suite |
| `failure` | a confirmed failure | the native module fails to load on this Node version |
| `solution` | a verified fix | reinstalling with the matching architecture restores the loader |
| `dependency` | a version or tooling constraint | Node.js 22.5+ is required |
| `location` | where something lives | MCP tools are registered in `src/mcp/server.ts` |
| `requirement` | a long-term project requirement | every memory must carry evidence |
| `risk` | a hazardous area | migrations must stay backward compatible |

The first seven columns of the table are not decoration. Type drives behavior:
the **declarative** types (`architecture`, `convention`, `decision`,
`dependency`, `location`, `requirement`, `risk`) participate in contradiction
detection, because two different answers to "what is the rule" cannot both be
true. The **episodic** types (`command`, `failure`, `solution`) do not, because
running the same command twice with different outcomes is history rather than
contradiction.

Every memory also carries:

- **scope** — `repository`, `module`, or `path`, with an optional value. Scope
  is part of a memory's identity: the same title under different modules is two
  facts, not a conflict.
- **confidence** — derived from evidence strength, not asserted by a model.
- **status** — `active`, `uncertain`, `superseded`, or `invalid`.
- **fingerprint** — a hash of type, redacted content, and scope. This is what
  makes recording the same fact twice a no-op rather than a duplicate, and it
  is why a retired memory owns its content permanently until forgotten or
  reactivated.
- **related files** with their hashes, sizes, and modification times, which is
  how staleness is detected.

Writing a good L1 memory means it survives without its conversation. "Fixed the
bug" is worthless later; "the Windows loader failed because the native module
was built for a different architecture, and reinstalling dependencies fixed it"
is reusable. Extraction deliberately produces few memories rather than
transcribing activity.

## L2 — Module narratives

An L2 narrative aggregates the L1 memories belonging to one
module: its responsibility and boundary, key files, the decisions that shaped
it, its common failure modes, and its current risks. Each claim would have to
trace to lower-layer records, and the narrative would need a length budget so
it does not decay into a second copy of the codebase.

## L3 — Repository profile

An L3 profile is the stable repository-level summary: stack, directory
responsibilities, build and test commands, core decisions, long-term
constraints, high-risk areas. It is the layer worth offering unprompted at the
start of a task, which is exactly why it must not be overwritten by one
low-confidence session. RepoMind derives it from evidence-backed repository L1
facts and L2 module boundaries, retains every generated version, and exposes
the complete source chain for inspection. A stale profile remains inspectable
but is not injected into a new task.

## L4 — Skill candidates (not implemented)

L4 would detect workflows repeated successfully across sessions and emit them
as *proposals* — trigger, inputs, steps, verification, risk, and the evidence
they came from. RepoMind would never install or execute one. A memory system
that starts running things is no longer a memory system.

## Why the layers matter

Each layer trades detail for context cost. L0 is complete and too expensive to
inject. L1 is small enough to hand an agent and specific enough to act on. L2
and L3 compress further at the cost of detail, which is why they stay
derivable from L1 and evidence rather than being written directly.

Related reading: [`memory-governance.md`](memory-governance.md) for the state
transitions, [`stale-detection.md`](stale-detection.md) for how file changes
are noticed, and [`architecture.md`](architecture.md) for where each layer
lives in the code.
