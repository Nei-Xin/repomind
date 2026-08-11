# ADR-001：RepoMind 是独立核心，不绑定单一 Agent

状态：accepted

## 背景

各类编码 Agent（Codex、Claude Code、OpenCode）都用自己的格式保存会话上下文。绑定某个宿主的记忆无法被其他宿主复用，而且宿主格式的变化不受我们控制。

## 决策

RepoMind 是独立的记忆层。领域模型不了解任何宿主的会话格式；宿主只通过可选的 `client_name` / `client_session_id` 字符串标识自己。

## 后果

- 同一个数据库服务于所有打开该仓库的 MCP 客户端。
- 宿主特有行为必须位于配置或轻量适配器中，绝不能进入核心。
- RepoMind 无法被动观察宿主活动；它依赖显式会话协议（参见 ADR-002）。
