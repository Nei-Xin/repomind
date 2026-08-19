# Transparent Claude Code integration (phase one)

This integration keeps the native interactive Claude Code process while
project hooks, Tencent MemoryProxy, and a local RepoMind Bridge perform recall,
L0 capture, and task finalization. Claude does not call RepoMind MCP lifecycle
tools, and `repomind run` is not involved.

```text
Claude Code --Anthropic API--> MemoryProxy --turn events--+
     |                                                  |
     +--project hooks--> RepoMind Bridge <--------------+
                              |
                              +--> RepositoryMemoryCore / SQLite
```

## Setup

Build and initialize the target repository:

```powershell
npm.cmd run build
node D:\path\to\repomind\dist\cli\entry.js init --repo D:\path\to\repository
```

Install MemoryProxy dependencies once, create its local configuration, then use
the unified service manager from the RepoMind source checkout:

```powershell
cd D:\path\to\repomind\services\memory-proxy
npm.cmd install
Copy-Item config.example.yaml config.yaml
cd D:\path\to\repomind
node .\dist\cli\entry.js services start
node .\dist\cli\entry.js services status
```

The manager starts the Bridge at `127.0.0.1:7345` and MemoryProxy at
`127.0.0.1:8096`, regardless of the host in `config.yaml`. PID state and logs
live under `REPOMIND_DATA_DIR/services/`, or `~/.repomind/services/` when no
override is set. Existing `REPOMIND_DATA_DIR` and `REPOMIND_BRIDGE_TOKEN` values
are inherited, and MemoryProxy receives `REPOMIND_BRIDGE_URL` with the loopback
Bridge URL when the variable is not already set. Stop only manager-owned
processes:

```powershell
node .\dist\cli\entry.js services stop
```

Install the project hooks separately:

```powershell
node D:\path\to\repomind\dist\cli\entry.js claude-hook-install `
  --repo D:\path\to\repository `
  --bridge-url http://127.0.0.1:7345
```

The installer merges definitions into `.claude/settings.local.json` and is
idempotent. Set the same `REPOMIND_BRIDGE_TOKEN` in the Bridge, MemoryProxy, and
Claude environments when bearer authentication is required.

For manual service startup instead of `services start`, configure the Bridge
URL before launching MemoryProxy:

```powershell
$env:REPOMIND_BRIDGE_URL = "http://127.0.0.1:7345"
```

Alternatively, configure the bridge in MemoryProxy's `config.yaml` so a
background launcher cannot lose the environment variable:

```yaml
repomind:
  enabled: true
  bridgeUrl: http://127.0.0.1:7345
  bridgeToken: ""
  timeoutMs: 3000
```

The startup log must contain `repomind.bridge {"enabled":true,...}`.

Then point Claude at the Proxy as described by the upstream project:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8096/claude-code/default"
claude
```

`UserPromptSubmit` starts a task and injects recall. Tool hooks capture local
activity. `Stop` records the final response, commits Git/test Evidence and L1
memories, then deterministically rebuilds L2 module narratives and the L3
repository profile. Only successfully committed tasks trigger L2/L3; stages with
no stable source are skipped, and maintenance failures are returned without
rolling back the committed task. `SessionEnd` abandons any remaining open task.
The first phase covers Claude only, keeps Bridge routing in process memory, and
does not include L0 rows in logical exports. Physical SQLite backups include
them. Async LLM extraction and idle finalization remain future work.
