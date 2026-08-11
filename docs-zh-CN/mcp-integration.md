# MCP 集成

RepoMind 作为本地 stdio MCP 服务器运行。配置客户端前请先构建：

```powershell
npm.cmd run build
node C:\path\to\repomind\dist\cli\index.js mcp
```

服务器暴露七个工具：

- `repo_session_start`
- `repo_memory_search`
- `repo_session_commit`
- `repo_memory_inspect`
- `repo_memory_validate`
- `repo_memory_correct`
- `repo_memory_invalidate`

## Codex

Codex 从用户级 `~/.codex/config.toml` 读取持久化 MCP 设置。可信仓库也可以提供 `.codex/config.toml`；在仓库被信任之前，项目配置会被忽略。

将 `examples/codex/config.toml` 复制到适当的配置文件，并将 RepoMind 构建路径替换为绝对路径。修改 MCP 配置后重启 Codex。在 Codex CLI 中使用 `/mcp` 列出已配置工具并检查服务器详情。

为了形成持久的任务行为，请将 `examples/codex/AGENTS.md` 中的相关规则复制到目标仓库的 `AGENTS.md`。MCP 注册使工具可用；仓库说明负责告诉 Agent 何时调用它们。

配置格式遵循当前 Codex MCP 配置参考：<https://learn.chatgpt.com/docs/extend/mcp>。

## 验证

1. 在已初始化仓库中启动 Agent A。
2. 确认七个 RepoMind 工具可用。
3. 要求 Agent A 启动 RepoMind Session、完成一个范围明确的修改、执行测试并提交 RepoMind Session。
4. 关闭 Agent A，启动新会话或第二个 MCP 客户端。
5. 搜索第一次 Session 中的决策或已验证命令。
6. inspect 返回的 Memory，确认它关联到 Git 和测试 Evidence。
7. 修改相关文件，再次搜索，并确认 Memory 变为 `uncertain`。
8. 验证、修正或使该 Memory 失效，并检查其 Evidence 和 Audit 历史。

RepoMind 无法自动观察宿主 Agent 的文件、Shell 或测试工具。Agent 必须显式调用 Session start 和 commit。MCP 进程重启后，请向 commit、inspect、validate、correct 和 invalidate 调用传入 `repo_path`。
