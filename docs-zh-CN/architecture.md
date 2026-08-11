# 架构

RepoMind 将编码 Session 转换为仓库知识，使其在产生知识的 Session 结束后仍然存续。本文解释各部分如何协同；每项结构选择背后的理由记录在 [`adr/`](adr/) 中。

## 分层

```text
MCP server  |  CLI  |  eval runners
                 |
       RepositoryMemoryCore
                 |
  storage (SQLite)  git (read-only)  security (redaction)
```

依赖只向下指向。核心不导入 MCP SDK，因此 CLI、测试和基准 runner 驱动的代码与 Agent 驱动的代码完全相同（[ADR-008](adr/ADR-008-core-independent-of-mcp-sdk.md)）。MCP 层解析参数、调用核心、将错误映射为稳定错误码并截断输出；它自身不包含业务规则，因此 CLI 与 MCP 的语义不会发生漂移。

## 身份与数据位置

`repomind init` 会将 `.repomind/project.json` 写入仓库，其中包含稳定 UUID 和名称，可以安全提交。其他所有内容都保存在 `~/.repomind/repositories/<projectId>/repomind.db`，可通过 `REPOMIND_DATA_DIR` 覆盖。因此同一项目的两个 checkout 共享一个记忆数据库，任何执行追踪都不会被意外提交（[ADR-007](adr/ADR-007-marker-in-repo-data-in-home.md)）。

每次查询和写入都携带仓库 ID。隔离并不是边缘位置附加的过滤器；仓库 ID 存在于每条语句中，而且基准场景会断言查询绝不跨越仓库。

## Session 协议

MCP 服务器只能看到对自身工具的调用。它无法观察宿主 Agent 的文件编辑、Shell 命令或测试运行，因此 RepoMind 不能被动记录 Agent 的行为（[ADR-002](adr/ADR-002-mcp-first-protocol.md)）。它改用显式协议：

```text
repo_session_start   capture Git baseline, recall relevant memories
   (agent works normally, using its own tools)
repo_session_commit  submit results; RepoMind re-reads Git and diffs
```

Agent 摘要是一项声明；Git 基线、最终状态、有界 diff 和测试退出码则是独立收集的 Evidence。这种不对称正是设计重点：结论的可信度取决于支撑它的 Evidence。

Commit 携带幂等键。重复 commit 会返回原始回执，不写入任何新内容，因此客户端重试不会产生重复知识。

## Memory 与 Evidence

Memory 和 Evidence 存储在独立的表中，通过 `memory_evidence` 关联（[ADR-005](adr/ADR-005-memory-evidence-separation.md)）。每条自动提取的 Memory 至少绑定一条 Evidence，因此 `repo_memory_inspect` 能回答“这条 Memory 为什么存在”，而不是要求用户盲目信任摘要。召回只返回 Memory 正文；Evidence 按需读取，避免大型 diff 默认进入 Agent 上下文。

Commit 阶段的提取保持确定性：决策生成 `decision` Memory，通过的测试命令生成已验证的 `command` Memory，成功摘要生成 `solution` Memory。远程 LLM 提取是针对已完成 Session 的独立显式阶段：

```text
load redacted Evidence -> remote call (no transaction) -> Zod + deterministic
validation -> one SQLite transaction -> dedupe, Evidence links, FTS, audit
```

在整个批次通过 schema、Evidence 子集、scope、confidence 和仓库路径验证之前，不会有任何模型输出进入数据库。一个无效候选项、超时或取消都会产生零写入（[ADR-009](adr/ADR-009-validated-output-before-persistence.md)）。远程提供方默认禁用，也绝不会作为 Session Commit 的一部分运行。

## 生命周期

```text
active -> uncertain -> active        validate
active/uncertain -> superseded       correct
active/uncertain -> invalid          invalidate
any -> (deleted, tombstone kept)     forget
```

Memory 根据具体信号而不是时钟变更状态（[ADR-006](adr/ADR-006-status-transitions-not-time-decay.md)）。有两类驱动信号：

**文件变化。** 每条 Memory 都记录相关文件哈希。Search 和 inspect 惰性刷新该状态：大小和 mtime 未变化的文件完全不会重新哈希；每次刷新中每个文件最多读取一次；最近两秒内被修改的文件始终重新哈希，因为发生在同一文件系统时间刻度的编辑可能保持大小和 mtime 不变。文件变化或删除会使 Memory 转为 `uncertain` 并附带具体警告，表示需要复核，而不一定表示错误。

**矛盾。** 当一条新的声明式 Memory 与另一条 Memory 具有相同类型、scope 和标题但内容不同，两者会通过 `contradicts` 关系相连并同时变为 `uncertain`。冲突事实绝不会被静默合并。事件型类型（`command`、`failure`、`solution`）不受此规则影响：重复执行产生不同结果属于历史，而不是矛盾。

只有 `forget` 会删除数据。它删除 Memory、索引项以及没有被其他 Memory 引用的 Evidence，同时在 `forget_log` 中留下不含内容的 tombstone，使删除行为本身仍可审计。

## 检索

搜索使用 FTS5 覆盖标题、内容、标签和相关文件，并采用标识符感知分词（camelCase、snake_case 和路径会拆成附加搜索词）。对于 FTS 结果过少的表意文字或单 Token 查询，还会使用子字符串回退。搜索始终限定在单个仓库并按状态过滤；`superseded` 和 `invalid` Memory 绝不会进入 Agent 上下文，`uncertain` 结果则携带警告。

向量检索是基于 sqlite-vec 的可选增强（[ADR-004](adr/ADR-004-fts5-before-vectors.md)）。搜索使用加权 reciprocal-rank fusion 合并词法与向量排名。向量缓存由 Memory 标题和内容派生，以提供方模型、维度和内容哈希为键。提供方或扩展失败时会回退到 FTS5，不阻塞写入。

## 存储

SQLite 是事实来源（[ADR-003](adr/ADR-003-sqlite-source-of-truth.md)）：启用 WAL 和外键，每个进程使用一个连接，打开时执行版本化迁移。FTS 是可重建的派生索引。每项跨多表写入都在一个事务中执行，因此失败的提取不会留下写到一半的 Memory。

## 安全边界

仓库文本是数据，而不是指令。系统只执行预定义的只读 Git 命令，并设置超时和输出上限（[ADR-010](adr/ADR-010-read-only-git-commands.md)）。路径解析后，任何越出仓库根目录的路径都会被拒绝。所有进入存储的内容都会经过脱敏，diff 捕获在 pathspec 层面排除敏感路径。威胁模型和模式脱敏的局限参见 [`../SECURITY.md`](../SECURITY.md)。
