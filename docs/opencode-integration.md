# OpenCode Integration

RepoMind can run as a project-local stdio MCP server in OpenCode. Build RepoMind first:

```powershell
npm.cmd run build
```

The repository-level `opencode.json` registers RepoMind with a relative command:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "repomind": {
      "type": "local",
      "command": ["node", "./dist/cli/index.js", "mcp"],
      "enabled": true
    }
  }
}
```

Verify the resolved configuration and MCP connection:

```powershell
opencode.cmd debug config
opencode.cmd mcp list
```

OpenCode should report `repomind` as connected. Start OpenCode from the repository root so the relative `dist/cli/index.js` path resolves correctly.

For consistent tool usage, apply the workflow in `examples/opencode/AGENTS.md` to the target repository's agent instructions.

RepoMind cannot observe OpenCode's other tools automatically. The agent must explicitly start and commit a RepoMind session.

## Host-managed lifecycle

Hosts that need deterministic lifecycle behavior can keep RepoMind outside the
model loop. The package exports four OpenCode integration helpers:

- `startHostLifecycle(repository, task, dataDirectory?)` starts retrieval and
  returns the session, memories, and measured start time.
- `hostManagedPrompt(task, memories)` renders the retrieved context for the
  OpenCode task prompt.
- `analyzeOpenCodeOutcome(jsonl, fallback)` extracts the final response and
  command/test evidence from OpenCode JSON events.
- `commitHostLifecycle(input)` stores the final Git diff, response, and test or
  command evidence with a measured commit time.

The controlled evaluation runner exercises this real integration with:

```powershell
node .\dist\cli\index.js eval --agent `
  --manifest D:\path\to\manifest.json `
  --lifecycle host-managed `
  --model cliproxyapi/gpt-5.6-terra `
  --output D:\path\to\results
```

In this mode OpenCode receives no RepoMind MCP server. The host owns session
closure, and the report counts start, Agent, and commit time in the end-to-end
total.
