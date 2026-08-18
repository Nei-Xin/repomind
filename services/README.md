# External Services

RepoMind keeps external runtime services under this directory, while their
runtime data stays in the ignored `tmp/` directory.

## MemoryProxy

`memory-proxy/` is the extracted Tencent MemoryProxy service used by the
Claude interactive adapter. It is part of the RepoMind checkout and does not
contain a nested Git repository.

The boundary is explicit:

```text
Claude Code -> MemoryProxy :8096 -> Anthropic upstream
Claude hooks + MemoryProxy -> RepoMind Bridge :7345 -> RepoMind SQLite
```

Configure the write-through path before starting the proxy:

```powershell
$env:REPOMIND_BRIDGE_URL = "http://127.0.0.1:7345"
```

Use `config.example.yaml` as the tracked template. Keep the local
`config.yaml`, `node_modules/`, logs, and other runtime files untracked.
