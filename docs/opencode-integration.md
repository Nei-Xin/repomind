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
