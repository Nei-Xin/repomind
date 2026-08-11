# Claude Code 集成

RepoMind 可以将 Claude Code 用作 Host-managed Coding Agent。请先安装并认证 Claude Code，然后验证可执行文件：

```powershell
claude --version
claude auth status --text
```

使用以下命令执行日常仓库任务，由 RepoMind 负责检索、Evidence Commit 和派生层维护：

```powershell
repomind run `
  --runner claude `
  --repo D:\path\to\repository `
  --task "Fix invoice quantity arithmetic and run the relevant tests" `
  --model gpt-5.6-luna `
  --timeout 600000 `
  --max-memories 5 `
  --context-budget 12000
```

当 `claude` 不在 `PATH` 中时，使用 `--runner-executable <path>`。省略 `--model` 可使用 Claude Code 配置的默认模型。RepoMind 始终传入 `--name`，避免 Claude Code 额外发起一次标题生成模型请求。它还使用非持久化的 `stream-json` 输出，以便审计命令 Evidence、Token 总量和最终结果。

## 权限边界

普通的 `repomind run --runner claude` 使用 Claude 的 `dontAsk` 模式，并配置以下显式 allowlist：

```text
Read, Glob, Grep, Edit, Write, Bash, PowerShell
```

这组权限支持常规仓库工作流，但不会静默授予所有可用工具。RepoMind 的日常 CLI 不提供 `bypassPermissions` 开关。只有调用方明确断言仓库是可信、由 Host 管理的隔离 checkout 时，Claude Adapter 才接受该模式。跨 Session Benchmark 的每个 stage 都由 Runner 创建全新的可丢弃 checkout，因此 RepoMind 会为这些 stage 作出该断言。仅为任意工作仓库选择 `--runner claude` 并不足以启用该模式。

## 结果与 Telemetry

Claude 的 stdout 会以脱敏 JSONL 保存。RepoMind 要求出现 `is_error=false` 且 `terminal_reason=completed` 的终止 `result`；只有进程退出码 0 并不足以判定成功。API 失败仍可能报告 `subtype=success`，因此该字段不参与成功门禁。

只有一个可唯一识别的 `tool_use` 恰好匹配一个 `tool_result` 时，Bash 和 PowerShell Evidence 才会被信任。缺失、重复或互相矛盾的结果都会使 Host Outcome 变为 inconclusive。Token Telemetry 只读取终止事件中累计的 `usage` 对象，避免重复统计 Assistant 和 Streaming 事件。Read 调用、重复路径和 `mcp__repomind__*` 调用会分别记录；Agent 侧 RepoMind 调用属于 Host 协议违规。

进行跨 Agent 学习实验时，请在 Manifest 的各个 stage 上分别设置 `runner` 和 `model`。详见 [`cross-session-agent-benchmark.md`](cross-session-agent-benchmark.md)。
