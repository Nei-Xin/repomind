# MCP Integration

RepoMind runs as a local stdio MCP server. Build it before configuring a client:

```powershell
npm.cmd run build
node C:\path\to\repomind\dist\cli\index.js mcp
```

The server exposes seven tools:

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_inspect`
- `repo_memory_validate`
- `repo_memory_correct`
- `repo_memory_invalidate`

## Codex

Codex reads durable MCP settings from the user-level `~/.codex/config.toml`. A trusted repository can also provide `.codex/config.toml`; project configuration is ignored until the repository is trusted.

Copy `examples/codex/config.toml` into the appropriate config file and replace the RepoMind build path with an absolute path. Restart Codex after changing MCP configuration. In Codex CLI, use `/mcp` to list the configured tools and inspect server details.

For durable task behavior, copy the relevant rules from `examples/codex/AGENTS.md` into the target repository's `AGENTS.md`. MCP registration makes tools available; the repository instructions tell the agent when to call them.

The configuration format follows the current Codex MCP configuration reference: <https://learn.chatgpt.com/docs/extend/mcp>.

## Verification

1. Start Agent A in an initialized repository.
2. Confirm the seven RepoMind tools are available.
3. Ask Agent A to start a RepoMind session, make a bounded change, test it, and commit the RepoMind session.
4. Close Agent A and start a new session or a second MCP client.
5. Search for the first session's decision or verified command.
6. Inspect the returned memory and confirm it links to Git and test Evidence.
7. Change a related file, search again, and confirm the memory becomes `uncertain`.
8. Validate, correct, or invalidate the memory and inspect its Evidence and Audit history.

RepoMind cannot observe the host agent's file, shell, or test tools automatically. The agent must explicitly call session start and commit. After the MCP process restarts, pass `repo_path` to commit, inspect, validate, correct, and invalidate calls.
