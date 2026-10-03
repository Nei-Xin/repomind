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

## 可选结构化交接

`repo_session_commit` 可在 summary 之外提供 handoff，用完整原文段落标注约束和
剩余工作。例如在现有 session_id、idempotency_key、status 等字段之外添加：

```json
{
  "summary": "Review closed.\n\nOnly on Linux, preserve case-sensitive matching.\n\nImplement the parser later.",
  "handoff": {
    "version": 1,
    "constraints": ["Only on Linux, preserve case-sensitive matching."],
    "remainingWork": ["Implement the parser later."]
  }
}
```

handoff 子对象固定使用 camelCase 的 `remainingWork`；原有外层字段仍叫
`remaining_work`。同时填写时两数组必须完全相同。每类最多 16 项，每项最多
2,000 Unicode code points，总计最多 4,000；各项必须是 summary 中唯一且完整的
段落，不能删掉警告、只取半句或改写文字。无效输入报 INVALID_INPUT，不写入数据。

第一条约束为完整单行且不超过 160 UTF-16 code units 时可用作新 solution 标题；
否则保留旧标题提取逻辑。正文保留原文，继续执行既有 Secret 脱敏。重复记忆仍
复用原记录，不重写旧标题。inspect 返回的 agent_summary Evidence.metadata_json
包含 handoffAudit，可检查段落来源位置、验证证据和实际标题是否应用。

不要在 handoff 里填写 verification、verified 或 Evidence ID。验证审计由系统根据
提交的 tests/commands Evidence 生成；MCP 自述结果仍为 caller-reported，不会因此
升级为已验证命令。缺省 handoff 完全兼容旧调用。OpenCode Host 可通过
`repomind run --runner opencode --task "..." --structured-handoff` 请求可选输出协议，
默认关闭；MCP 提交不依赖此开关。Host 无效输出记录诊断并回退，显式 MCP 无效输入
仍拒绝提交。
完整边界见 [结构化交接设计与验收](structured-handoff-v1.md)。
