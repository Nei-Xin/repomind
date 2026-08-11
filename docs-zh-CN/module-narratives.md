# L2 Module Narrative（模块叙述）

RepoMind v0.12 在原子 L1 Memory 之上加入真正的派生记忆层。L2 独立存储；module scope 的 L1 Memory 不会被重新标记或当成 Narrative。

## 来源资格

一条 Memory 只有满足以下条件才能贡献内容：

- 位于同一仓库；
- 状态为 `active`，而不是 uncertain、superseded 或 invalid；
- 至少关联一条 Evidence；
- 显式分配给一个 module，或关联到父目录可标识 module 的文件。

显式 `module` scope 优先于从文件派生的 module。否则，当 Evidence 相关文件跨越模块边界时，一条 L1 Memory 可以支持多个 module。

## 重建

```bash
repomind module-rebuild --json
repomind module-rebuild --module src/storage,src/mcp --budget 4000 --json
```

默认预算为 4,000 字符，可接受 500 到 20,000。内容分组为关键文件、职责和边界、技术决策、失败与验证、当前风险。每项结论都包含来源 Memory ID。

RepoMind 会对有序来源 ID、L1 fingerprint、更新/验证时间和 Evidence 数量计算哈希。Fingerprint 和预算相同时结果为 `unchanged`；module 变化时 L2 版本递增；指定 module 没有合格来源时，其派生 Narrative 会被删除。

成功的 `repomind run` Host Commit 之后，RepoMind 会同步调用相同的默认 rebuild，作为 best-effort 派生维护。没有合格 L1 来源且没有既有 Narrative 需要维护时，L2 状态记为 skipped。L2 维护错误会独立报告，不能回滚已 committed 的 Session，也不会改变 Host-run 成功状态。partial、failed 和 abandoned Run 不自动 rebuild L2。

自动路径只属于 Host-managed 生命周期。`module-rebuild` 和 `repo_module_rebuild` 仍然可用；Agent-managed Session、直接 CLI Commit、MCP Commit 和直接 Core Commit 需要新鲜 L2 时，必须显式调用其中之一。

## 新鲜度与来源

```bash
repomind modules --json
repomind module-inspect l2_... --json
```

`modules` 会重新计算来源 fingerprint，并在过期 Narrative 注入 Session Start 前报告 `current: false`。`module-inspect` 返回贡献内容的 L1 Memory ID、类型、标题、confidence、相关文件和 Evidence ID，形成以下追踪链：

```text
L2 conclusion -> L1 memory -> Evidence
```

搜索使用独立 L2 FTS 索引。`repomind reindex` 从 SQLite 来源表重建 L1 和 L2 索引。

## MCP 与任务启动

MCP 客户端使用 `repo_module_rebuild`、`repo_module_list` 和 `repo_module_inspect`。`repo_session_start` 还会返回最多两个与任务匹配的当前 L2 Narrative。过期 Narrative 仍可 inspect，但不会作为任务上下文返回。

`repomind run` 会把相关 current Narrative 与 current L3、排序 L1 一起放入共享的仓库上下文预算。完整当前任务和固定 Host 生命周期说明不在该预算内。

## 当前边界

首个 L2 实现是确定性的。它不会推断未记录的 module 历史、使用远程 LLM 或替代 L1 检索。L3 Repository Profile 通过独立的 confidence 过滤投影使用其模块边界；L4 Skill Candidate 通过自身需要审查的工作流维护。
