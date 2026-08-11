# L3 Repository Profile（仓库画像）

RepoMind v0.12 在原子 L1 Memory 和 L2 Module Narrative 之上加入仓库级 Profile。L3 是独立、版本化的派生记录，不是换名后的 L1 Memory，也不会替代任务特定的 L1/L2 检索。

## 来源资格

仓库事实只有同时满足 active、repository scope、有 Evidence 支持、属于稳定事实类型且达到配置的 confidence 阈值时才能贡献内容。稳定事实类型包括 architecture、convention、decision、command、dependency、requirement 和 risk。

L2 提供模块边界。RepoMind 将每个 Narrative 投影回其 active、有 Evidence 支持的 L1 来源，并再次应用 L3 confidence 阈值。因此，即使低 confidence L1 导致 L2 Narrative 版本变化，L3 fingerprint 也会忽略它。

## 重建与检查

```bash
repomind profile-rebuild --json
repomind profile-rebuild --budget 6000 --min-confidence 0.8 --json
repomind profile --json
repomind profile-inspect --json
```

默认预算为 6,000 字符，可接受范围是 1,000 到 30,000。默认最小 confidence 为 0.8，可接受范围是 0.5 到 1。若合格来源 fingerprint、预算和 confidence 阈值相同，重建结果为 unchanged；fingerprint 变化则版本递增。每个版本都会保留渲染内容和来源 ID。

成功的 `repomind run` Host Commit 之后，RepoMind 会先 rebuild L2，再同步尝试此次 L3 rebuild。没有稳定 L1 或 current L2 来源符合条件时，L3 maintenance 记为 skipped，而不是 failed。其他 L3 维护错误会独立记录，不回滚 committed Session，也不改变 Host-run 成功状态。partial、failed 和 abandoned Run 不尝试 L3 维护。

该自动路径只属于 Host-managed 生命周期。`profile-rebuild` CLI 命令与 `repo_profile_rebuild` MCP Tool 仍然可用；Agent-managed Session、直接 CLI/MCP Commit 和直接 Core Commit 必须显式触发 rebuild。

`profile-inspect` 暴露当前存活的 L1/L2 来源链接、Evidence ID 和全部保留的 Profile 版本，支持两条追踪链：

```text
L3 conclusion -> repository L1 memory -> Evidence
L3 module boundary -> L2 narrative -> module L1 memory -> Evidence
```

## 新鲜度与任务启动

`profile` 会重新计算合格来源 fingerprint。合格来源变化时，现有 Profile 报告 `current: false`。它仍可 inspect 和 rebuild，但重建前不会被 Session Start 注入。

CLI task start 默认包含当前 Profile。使用 `start --no-profile` 可禁用。MCP 客户端通过 `repo_session_start` 获得相同行为；将 `include_repository_profile` 设为 `false` 可退出。L3 专用 MCP 工具为 `repo_profile_rebuild`、`repo_profile_get` 和 `repo_profile_inspect`。

在 `repomind run` 中，只有 current Profile 有资格与相关 current L2、排序 L1 一起进入共享仓库上下文预算。完整任务和固定 Host 生命周期说明既不计入预算，也不会被截断。

## 当前边界

该实现是确定性且本地的。它不声称具备远程 LLM 提取质量、10,000-L1 规模、第二个真实客户端上的跨 Agent 互操作性、export/import 或 backup/restore、macOS 兼容性、覆盖率证明或 L4 Skill Candidate 生成能力。这些仍是明确发布目标。
