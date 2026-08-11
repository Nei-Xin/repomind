# ADR-002：MCP 是首个公开协议，而不是宿主工具钩子

状态：accepted

## 背景

MCP 服务器只能看到对自身工具的调用。它无法观察宿主 Agent 的文件编辑、Shell 命令或测试执行，因此仅依靠 MCP 无法实现“自动捕获 Agent 所做的一切”。

## 决策

RepoMind 通过 MCP stdio 暴露显式会话协议：`repo_session_start` 捕获 Git 基线，Agent 正常工作，随后 `repo_session_commit` 提交结果；RepoMind 会重新读取 Git 状态以计算可验证的差异。未来宿主钩子可以补充追踪信息，但不得成为硬依赖。

## 后果

- Evidence 质量取决于 Agent 是否调用 commit；CLI 会列出长时间未关闭的会话，作为安全保障。
- Git 快照和 diff 是独立于 Agent 诚信度的客观 Evidence 来源。
- `repomind mcp` 的 stdout 只承载 JSON-RPC，日志写入 stderr（自动化纯净性测试会验证这一点）。
