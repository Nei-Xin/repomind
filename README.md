# RepoMind

**Evidence-backed repository memory for coding agents.**

RepoMind helps coding agents carry useful repository knowledge from one task to the next. It captures task evidence, turns reusable findings into memories, and retrieves relevant context when a new task begins. OpenCode, Claude Code, and MCP clients can work with the same repository memory.

A later session can recall why a module was designed a certain way, which command verified a change, or how a previous issue was resolved—and inspect the evidence behind that knowledge.

## Why RepoMind

Working in an existing repository means learning more than its source code. Agents also need its conventions, design decisions, verification commands, and lessons from earlier tasks. Those findings are often scattered across conversations and have to be rediscovered in a fresh session.

RepoMind makes that knowledge reusable:

- **Continue across sessions.** Retrieve relevant findings when starting a new task.
- **Share context across agents.** OpenCode and Claude Code can use the same project memory on the same machine.
- **Keep conclusions traceable.** Memories link back to task evidence, Git changes, and command results.
- **Keep context focused.** Retrieve compact facts and module summaries within a context budget.
- **Maintain knowledge as code changes.** File changes flag linked memories for review; corrections and invalidations retain their history.

## How it works

```mermaid
flowchart LR
    Task[New task] --> Recall[Retrieve repository context]
    Recall --> Agent[Agent works on the repository]
    Agent --> Evidence[Capture task evidence]
    Evidence --> Memory[Store reusable memories]
    Memory --> Recall
```

RepoMind uses a Session to connect a task with its starting repository state, observed activity, final response, and verification results. Successful tasks can produce reusable memories. Host-managed runs and configured interactive integrations also maintain derived context after a successful commit.

The memory model has five layers:

| Layer | What it contains | What it is useful for |
| --- | --- | --- |
| **L0 — Activity and evidence** | Task requests, tool activity, Git snapshots, diffs, and command results | Inspecting what happened and supporting conclusions |
| **L1 — Individual memories** | Repository facts, conventions, decisions, solutions, and verified commands | Recalling specific knowledge for a task |
| **L2 — Module narratives** | Bounded summaries derived from memories about a module | Understanding module responsibilities and decisions |
| **L3 — Repository profile** | A compact overview derived from repository facts and module context | Orienting an agent at the start of a session |
| **L4 — Skill candidates** | Repeated successful workflows proposed for review | Turning recurring work into reusable instructions |

L2 and L3 retain links to their sources. L4 candidates require approval before export. See the [memory model](docs/memory-model.md) and [architecture](docs/architecture.md) for more detail.

## Quick start

Requirements: **Node.js 22.5+** and **Git**. Install OpenCode or Claude Code to run agent tasks through RepoMind; the CLI and MCP memory operations can also be used independently.

Install from the source checkout to use the current RC.3 functionality:

```bash
git clone https://github.com/Nei-Xin/repomind.git
cd repomind
npm ci
npm run build
npm link
```

A versioned RC.2 tarball is also available through [GitHub Releases](https://github.com/Nei-Xin/repomind/releases/tag/v1.0.0-rc.2). The unscoped npm package `repomind` belongs to another project; use this repository's source or release artifact.

Inside the Git repository you want RepoMind to remember:

```bash
repomind init
repomind doctor --runner opencode
repomind run --task "Fix invoice decimal arithmetic and verify the change" --runner opencode
```

RepoMind retrieves repository context before launching the agent, captures the task's evidence, and closes the Session when the run ends. Successful commits update reusable memory and derived context.

For Claude Code, use `--runner claude`:

```bash
repomind doctor --runner claude
repomind run --task "Explain the invoice module and verify its tests" --runner claude
```

Omit `--model` to use the selected agent's default. Use `--context-budget` to control the amount of injected repository context; the default is 12,000 characters.

## Ways to use RepoMind

### Run a task with lifecycle management

`repomind run` manages retrieval, agent execution, evidence capture, and Session completion. This is the quickest way to try the complete workflow.

See the [daily workflow guide](docs/daily-workflow.md) for task history, memory review, and ongoing use.

### Work interactively in OpenCode or Claude Code

Configure OpenCode once for the target repository, then launch it normally:

```powershell
repomind opencode setup --repo D:\path\to\repository
repomind opencode status --repo D:\path\to\repository
cd D:\path\to\repository
opencode
```

The project plugin retrieves context for root-session user messages, captures tool activity—including delegated child-session activity—and closes the task when the root session becomes idle. It uses a local Bridge and does not require the model to call MCP tools.

Claude Code interactive integration uses project hooks and the same local Bridge; Claude keeps talking to its own model endpoint. Configure the repository once, then run `claude` normally:

```powershell
repomind claude setup --repo D:\path\to\repository
repomind doctor claude --repo D:\path\to\repository
```

See [OpenCode integration](docs/opencode-integration.md) and [Claude Code integration](docs/claude-integration.md) for the available workflows and setup details.

### Connect an MCP client

Add RepoMind to the client's MCP configuration:

```json
{
  "mcpServers": {
    "repomind": {
      "command": "repomind",
      "args": ["mcp"]
    }
  }
}
```

The MCP tools cover Session management, memory search and inspection, memory maintenance, module narratives, repository profiles, and Skill candidates. See the [MCP guide](docs/mcp-integration.md) and [client examples](examples/) for repository selection and tool configuration.

## Explore and maintain memory

Search for a finding and inspect its supporting evidence:

```bash
repomind search "invoice decimal arithmetic" --json
repomind inspect <memory-id> --json
```

Record a repository fact directly:

```bash
repomind record --type convention --title "Public API types" --content "Public APIs export explicit TypeScript types."
```

Review knowledge affected by code changes and browse the derived layers:

```bash
repomind review
repomind modules --json
repomind profile --json
repomind skills --status pending --json
```

You can validate, correct, invalidate, or forget memories through audited operations. A changed file marks related knowledge for review; you decide whether the conclusion still applies. [Memory governance](docs/memory-governance.md) explains these operations.

For manual Session management, use `repomind start` and `repomind commit`. For an existing repository with no memory yet, the [bootstrap workflow](docs/daily-workflow.md) generates candidates for review before import.

## Local storage and optional capabilities

RepoMind stores memory in a local SQLite database with FTS5 search. Repository identity lives in `.repomind/project.json`; memory data lives under `~/.repomind/repositories/<projectId>/repomind.db`. Set `REPOMIND_DATA_DIR` to choose another data directory. Interactive setup also installs project-specific plugin or hook configuration.

The default workflow uses deterministic memory extraction and local lexical search. Additional capabilities are opt-in:

| Capability | Purpose | Documentation |
| --- | --- | --- |
| Vector search | Combine lexical and vector retrieval using a configured embedding provider | [Vector search](docs/vector-search.md) |
| Remote LLM extraction | Generate structured memory candidates from a completed Session's evidence | [Remote extraction](docs/remote-llm-extraction.md) |
| Export and backup | Move or recover repository memory, with optional encrypted archives | [Data portability](docs/data-portability.md) |
| Skill candidates | Review and export repeated successful workflows | [Skill candidates](docs/skill-candidates.md) |

Remote providers receive the relevant text after pattern-based secret redaction; vector queries are also redacted before embedding. See [SECURITY.md](SECURITY.md) for the data boundaries and redaction model.

## Development and evaluation

```bash
npm run typecheck
npm test
npm run build
```

The project includes tests for memory lifecycle, retrieval, agent integrations, and data portability, plus retrieval benchmarks and cross-session agent experiments. Evaluation methods and results are documented separately:

- [Retrieval benchmarks](docs/benchmark.md)
- [Agent task benchmarks](docs/agent-benchmark.md)
- [Cross-session experiments](docs/cross-session-agent-benchmark.md)
- [Chinese project report and learning guide](project-report-zh-CN/README.md)

For deeper reading, see [architecture](docs/architecture.md), [design decisions](docs/adr/README.md), [contributing](CONTRIBUTING.md), and [troubleshooting](docs/troubleshooting.md). Version history is maintained in the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE)
