# ADR-008：核心不依赖 MCP SDK

状态：accepted

## 背景

CLI、测试、基准 runner 和未来适配器都需要相同的业务逻辑。若领域层绑定 MCP SDK，所有使用方都必须经过协议类型，而且没有客户端就无法测试核心。

## 决策

`RepositoryMemoryCore` 以及 `src/domain`、`src/storage`、`src/git`、`src/security`、`src/eval` 下的全部代码都不得导入 `@modelcontextprotocol/sdk`。MCP 层（`src/mcp/server.ts`）只负责解析参数、调用核心、映射错误和截断输出。

## 后果

- CLI 和 MCP 调用相同方法，因此暴露完全一致的语义。
- 评估套件直接驱动真实核心，不承担协议开销。
- MCP schema 变化不会扩散到领域类型。
