# 06 工程亮点、限制与路线图

## 1. 项目最有价值的工程亮点

### 1.1 把 Agent Memory 做成有生命周期的数据系统

很多 Agent Memory 项目停留在“把文本写进向量库，再做相似度搜索”。RepoMind 额外实现了：

- Session start/commit/abandon；
- Git baseline/final/diff；
- Evidence 与 Memory 多对多关系；
- 状态、冲突、陈旧、纠错、失效和物理删除；
- 审计日志和幂等回执；
- L0-L4 派生层；
- 导出、恢复和加密归档；
- 真实 Agent 三臂实验。

这使项目从“检索组件”提升为“仓库知识的完整数据生命周期”。

### 1.2 Evidence/Memory 分离

这是最核心的数据建模亮点：

- Recall 只返回少量结论，控制 Prompt 成本；
- Inspect 才展开 Evidence、文件、关系和 Audit；
- 一条 Memory 可以由多个 Session 的 Evidence 支持；
- Forget 只删除无其他引用的 Evidence；
- L2/L3/L4 都能保留到底层来源的链路。

这是一种适合 Agent 系统的“读路径压缩 + 审计路径展开”。

### 1.3 Host-managed 生命周期移出模型循环

v0.7 的失败和 v0.8 的成功清楚展示了架构迭代：

- Agent-managed 正确率达到目标，但额外模型轮次使其比 full-history 慢 39.713%；
- Host-managed 在模型外完成 Start/Commit，正式 v0.8 变为比 full-history 快 12.711%；
- Core 不变，变化集中在生命周期所有权。

它体现了 Agent 工程中的重要原则：确定性工作应尽可能放到模型循环外，模型负责需要推理的代码任务，宿主负责状态和协议。

### 1.4 一个 Core 服务所有入口

CLI、MCP、OpenCode Host、测试和评测都调用 `RepositoryMemoryCore`。MCP 只做参数解析和错误映射，避免同一规则在多个客户端漂移。

这也让跨 Agent 成为协议兼容问题，而不是重新实现数据库和业务规则。

### 1.5 针对代码仓库优化的检索

RepoMind 没有默认依赖昂贵语义模型，而是先优化代码检索的真实特性：

- camelCase/snake_case/kebab/path 拆分；
- CJK overlapping bigram；
- FTS5 BM25；
- 单 token/CJK substring fallback；
- 可选向量；
- weighted RRF 以词法为主；
- Provider/extension 失败降级 FTS。

这比“所有文本都做 Embedding”更符合本地工具、标识符密集和可用性优先的场景。

### 1.6 Stale 检测兼顾准确性与规模

保存 hash + size + mtime，并使用两秒 racy-mtime 窗口：

- 普通情况只做 stat；
- 最近修改即使 metadata 一样也重新 hash；
- 同一刷新中相同文件只读一次；
- 变化只标 uncertain，不自动删除。

这是一套可解释、可测试的增量失效策略。

### 1.7 冲突不静默覆盖

新声明性事实与同 type/scope/title 的不同内容发生冲突时：

- 双方保留；
- 双方 uncertain；
- 建立 `contradicts` relation；
- 写 Audit；
- 交给 validate/correct/invalidate/forget 处理。

对 Agent Memory 来说，“保留矛盾并暴露不确定性”通常比“最后写入覆盖旧事实”更安全。

### 1.8 远程模型输出先整批验证再写入

Remote Extraction 的结构是：

```text
remote generation outside transaction
  -> strict schema
  -> Evidence subset / scope / path / bounds validation
  -> one transaction
```

任何非法 Candidate 使整批零写入。这种边界比“边生成边落库”更能防止状态污染，也便于 mock 测试取消、超时和伪造 Evidence。

### 1.9 L4 保持 review-only

系统只识别重复成功工作流、生成 Candidate、要求审批并导出 Markdown，不自动执行。Memory 系统一旦自行执行未知命令，就跨越到 Automation/Agent Runtime 的风险域。当前边界保留了 human-in-the-loop。

### 1.10 用负面实验驱动架构

项目没有隐藏 v0.7 的正式失败，而是保留报告、分析原因、修改 Host 架构，再进行 v0.8 同批配对验收。这比只展示最佳结果更能体现工程成熟度。

## 2. 安全与数据保护的已实现能力

### 2.1 Git 调用边界

[`git-inspector.ts`](../src/git/git-inspector.ts) 使用 `execFileSync("git", args)`：

- 不拼接 Shell 字符串；
- 固定 Git 子命令和参数结构；
- 10 秒 timeout；
- 1 MiB stdout 上限；
- 不执行 commit/push/checkout/reset/clean；
- diff 默认 64 KiB；
- 敏感 pathspec 排除。

准确表述是“不修改 worktree、index 和 refs”。首次提交的 empty-tree 路径会调用 `git mktree`，严格说可能向 object database 写入对象，所以不宜绝对声称“所有 Git 调用没有任何写入”。

### 2.2 Secret Redaction

已覆盖常见：

- private key block；
- AWS access key ID；
- GitHub/Slack/OpenAI-like token；
- JWT；
- credential assignment；
- Bearer token。

敏感 Git 路径包括 `.env*`、`.npmrc`、常见 pem/key/p12/pfx 和 SSH key 文件。

Evidence content/metadata value、Session task、Memory 字段、Audit 和导出 Skill 会经过相应脱敏。匹配会留下 `[REDACTED:<kind>]`，便于知道发生了什么。

### 2.3 加密归档

- AES-256-GCM；
- scrypt `N=32768, r=8, p=1`；
- 32-byte key；
- 16-byte salt、12-byte IV、16-byte tag；
- header metadata 作为 AAD；
- passphrase 只从环境变量读取；
- 错误密码、篡改、purpose mismatch 在目标写入前失败；
- 加密 restore 的临时明文在 `finally` 清理。

### 2.4 恢复边界

- Logical Import 是显式 replace，先 dry-run；
- Physical Restore 要求相同 Project ID；
- 替换前保存 pre-restore snapshot；
- 失败恢复 live DB/WAL 状态；
- open Session 或 running Host Run 时拒绝数据替换。

## 3. 必须诚实说明的产品边界

| 主题 | 当前边界 | 影响 |
| --- | --- | --- |
| 自动观察 | MCP 看不到宿主其他工具 | 必须 Start/Commit 或使用 Host Adapter |
| Host Adapter | 已注册 OpenCode 与 Claude Code；Codex 未接入 | OpenCode -> Claude 单任务 repeat 5 已通过；反向、多任务与 Codex 同等验收仍缺失 |
| Host 上下文 | current L3 + relevant current L2 + ranked L1；默认 12k、范围 1k-24k | 预算只约束三个 repository-context section；完整 task/生命周期说明在预算外；L2/L3 已在 `L1=0` 的 Claude consumer 中被验证，尚缺分层消融与紧预算验证 |
| 分层维护 | 成功 Host Commit 自动 best-effort；其他入口显式 rebuild | partial/failed/abandoned 不维护；失败单独报告，不回滚 Session |
| 跨 Agent | 同机、同 data dir、同 Project ID | 不是云同步或团队服务 |
| 多分支 | Memory 状态 project-global | 一个 checkout 可使共享 Memory uncertain |
| 测试 Evidence | Core 不重跑命令 | “verified”依赖宿主上报 exit code |
| 冲突 | 同 type/scope/title 启发式 | 有漏检和误报，不理解任意语义 |
| Stale | 只覆盖 related files | 纯语义撤回和无 related file Memory 不可自动发现 |
| 默认检索 | FTS5；Embedding 关闭 | 不能默认声称语义向量召回 |
| Remote | 显式 opt-in | 开启后相应仓库内容会离开本机 |
| L4 | 自动阶段只生成/刷新 pending Candidate；人工 review + export | 不自动批准、导出、安装、执行，不等于自动技能学习平台 |
| Import | replace-only | 无历史合并和冲突 UI |
| Live storage | SQLite 明文 | 归档加密不保护 live DB |
| 用户模型 | local single-user | 无认证、权限、多租户隔离 |

## 4. 深度审计发现的具体限制

### 4.1 Project Marker 与数据库路径硬化已闭环

初次审计发现 `projectId` 只校验非空，恶意 marker 可能用 `..` 影响数据路径。当前工作树已修复：`readProjectMarker` 要求 canonical UUID；`databasePath` 再次校验 UUID，对 data root、`repositories/`、Project 目录和 SQLite/WAL/SHM 路径做 canonical containment，并拒绝 linked repositories root 与 linked project directory。测试覆盖 path separator、`..`、绝对路径、畸形 UUID 和 Windows junction/目录 symlink。

随后审计又发现 POSIX dangling DB/WAL/SHM symlink 边界，并已把链接检测改为 `lstatSync`：只忽略真正的 `ENOENT`，链接本身即使目标不存在也会被拒绝。剩余边界主要是 marker 仍为仓库内可编辑的身份指针，而不是认证凭证：攻击者可以写入另一个格式合法、且本机恰好存在的 Project ID，使 checkout 指向另一份本地数据。跨不可信仓库仍应结合目录权限、显式身份确认或 marker-to-remote binding；路径检查也仍有通用的检查后替换（TOCTOU）窗口。

### 4.2 `relatedFiles` Symlink 边界已修复

审计最初发现 related file 只做 `resolve/relative` 词法 containment，仓库内 symlink/junction 可指向仓库外文件并被读取、哈希。当前实现已在词法检查后执行 `realpathSync.native`，对 canonical target 再做一次仓库 containment；缺失、不可访问和越界目标统一保持空 fingerprint，不读取外部内容。

回归覆盖 Windows junction、POSIX 目录/文件 symlink、记录后把缺失路径替换成外部链接，以及外部内容后续变化。剩余的是文件系统通用 TOCTOU：canonical 检查与随后 `stat/read` 不是同一文件句柄上的原子操作；高对抗场景可进一步使用安全 open/handle 语义。

### 4.3 Hybrid Query 的脱敏不一致

Start 存储 task 时脱敏，但 `startSessionHybrid` 使用原始 `input.task` 查询；远程 Embedding 开启后原始查询会发给 Provider。

建议：用脱敏后的 task 做 Hybrid Query，或将本地/远程 query 输入策略显式分开并在 status 中报告。

### 4.4 部分元数据未统一脱敏

`scopeValue`、`clientName/clientSessionId`、Commit `idempotencyKey` 等没有完全走统一 Redaction。`redactDeep` 只处理 JSON value，不处理 object key。

建议：定义一份持久化字段安全矩阵，并在 DB 写入边界统一处理；对标识字段使用格式限制而不是仅正则替换。

### 4.5 Commit 并发边界

幂等能可靠处理同 key 顺序重试，但 receipt 和 Session status 先于写事务检查。两个进程用不同 key 并发 Commit 同一 open Session，没有完整的事务内 compare-and-set。

建议：在 `BEGIN IMMEDIATE` 事务内执行 `UPDATE ... WHERE status='open'` 并检查 changes，再处理 receipt；或增加 Session version。

### 4.6 Git Evidence 不是原子快照

branch、HEAD、status 和 diff 来自多次 Git 调用，期间仓库可以变化。Diff 也有边界：

- 不含 untracked 内容；
- 最大 64 KiB；
- sensitive file 名仍可能出现在 status；
- related files 来自 final status，而不是任务 diff；
- 最终 clean commit 可能导致 related files 为空；
- porcelain v1 未用 `-z`，特殊路径和复杂 rename 解析不够稳健。

建议：使用 `--porcelain=v1 -z`，把 committed/staged/working 的 changed-file 集合单独结构化保存，并记录采集前后 HEAD 以检测竞态。

### 4.7 Host 已修复失败命令误判，测试策略仍可加强

审计复现过“构建命令失败、Agent 进程正常退出，Run 仍标为 committed/succeeded”的问题。当前实现已改为要求所有被观察到的 bash/shell command 都 `exitCode === 0`；任一失败会把 Session Commit 为 `partial`、`succeeded=false`，并跳过 L2-L4 maintenance，避免污染成功 Solution 和派生层。对应回归测试同时断言 maintenance 未调用。

剩余边界是 Host 只解析注册 Adapter 的已知事件：OpenCode bash/shell，以及 Claude Bash/PowerShell 的唯一 `tool_use`/`tool_result` 配对。未知事件无法自动解释；没有识别到测试时也不会强制“至少一个测试”。因此当前结论是“已观测命令无失败”，不是“按项目策略完成了充分验证”。

建议：引入 manifest/命令策略：

- `requireAtLeastOneTest`；
- 指定允许的 test command pattern；
- 区分 build/lint/test；
- 记录未测试成功而不是隐式视为全部测试通过。

### 4.8 分层 Host 管线已接入，正式 uplift 证据目前来自 L1

当前 Host 已按清晰标签渲染 current L3、相关 current L2 和排序后的 L1，默认 repository-context 预算 `12,000` 字符、可配置 `1,000-24,000`，按 L1:L2:L3=`5:3:2` 加权分配。完整 task 与固定生命周期/信任说明在预算外且不截断；过期 L2/L3 不注入，报告保留逐层截断/省略统计。

Prompt 当前作为 argv 参数传给 OpenCode 或 Claude Code。审计曾用大量引号复现“Prompt 低于 28,000 但 quoting 后触发长度问题”；两个 Adapter 都保留 28,000 字符 Prompt guard，并按 libuv Windows quoting 估算 command 和全部 argv 的完整命令行，超过 `32,767` 字符时在 spawn 前拒绝并 abandon Session。17k 引号膨胀用例已进入 Windows 回归。剩余产品约束是任务仍走 argv；stdin/临时文件会从架构上更稳健，也便于处理更长任务。

v0.8 的 72 次和 2026-08-04 RC 的 120 次仍来自旧 L1-only Host 路径。2026-08-11 已在 fresh suite、顺序轮换、固定模型与独立审计条件下完成新的 120-stage 跨 Session 实验：correctness 的 shared/isolated hidden 为 15/15 与 0/15；efficiency 的 Host 时长和 total prompt 均值分别下降 18.055% 与 11.854%，但该轮 uplift 由 L1 承担。后续 OpenCode -> Claude 单任务 repeat 5 已在 L1=0 时稳定注入 L2/L3，shared consumer 5/5、isolated 0/5，且独立审计 14/14 通过。

2026-08-12 的 18-run 三臂复核进一步得到 RepoMind/full-history/no-memory hidden `6/6、6/6、2/6`，Integrity 与 Acceptance 全部通过。RepoMind 相对 no-memory 减少 28.2% wall time 和 46.2% file reads；相对 full-history 正确率相同、耗时近似，input token 点估计高 22.1%。本轮实际注入 L1/L2/L3=`1/0/0`，所以它强化了 L1-dominant Host 路径证据，而不是 L2/L3 独立效果证据。

### 4.9 L2 搜索的 stale 截断顺序

L2 FTS 先 limit，再由 Core 过滤 `current=false`；排名靠前的陈旧 Narrative 可能占掉候选位，导致后面的 current 项未返回。

建议：在 SQL 层连接 source/current 条件，或扩大内部候选池后再过滤并补足 limit。

### 4.10 L4 丢失顺序和任务语义

L4 的签名是排序后的成功命令/测试集合：

- 执行顺序丢失；
- 同命令集不同任务可能误归组；
- 语义别名不归一化；
- Inputs 不做参数推断；
- 审批没有身份认证，Agent 理论上可自行 approve。

建议：保留原始 event sequence；签名加入任务类别、文件范围和关键输出；Approval 由 Host policy 控制；导出前做顺序一致性检查。

### 4.11 Bootstrap 不是防篡改知识导入

Bundle 没有签名。Apply 会验证 Project ID、Candidate ID 和 source hash/HEAD，但不会从源重新派生正文做完整比对；多个 Candidate 也是逐个 `record`，不是全批事务。

建议：Bundle 签名或至少保存 canonical source slice hash；Apply 重新派生；整批一个事务；报告部分成功风险。

### 4.12 Prompt Injection 防护不是语义或结构证明

远程提取把仓库内容标成 untrusted，强制 structured output 和 Evidence ID，但无法证明 Candidate 正文真的由 Evidence 蕴含。Host context 当前会拒绝 task NUL、移除 L1-L3 NUL，并将每条不可信记录逐行渲染为 Markdown blockquote；即使 Memory 包含 `## Current Task`，也只会成为 `> ## Current Task`，最终 Prompt 只保留一个未引用的真实任务标题。该结构碰撞问题已有回归测试。

这仍不是“语义 Prompt Injection 已解决”：模型仍会阅读引用块，其他控制字符也没有形成完整策略，trust notice 仍属于模型层约束。

建议：远程提取增加 claim-to-evidence 引文范围、第二阶段 verifier、人工 Review Queue 和 provider-specific sandbox；Host context 继续扩充控制字符策略并做对抗 Prompt 测试；始终保留 confidence <= 0.9。

### 4.13 Vector 同步退休 Memory

Vector sync 会为所有 Memory 建缓存，再在查询时按状态过滤。数据库大、远程 Provider 开启时，会为 superseded/invalid 内容浪费时间和费用。

建议：只同步 live 状态，或把 retired vector 作为可回收缓存；记录 provider 调用量和成本。

### 4.14 文档版本漂移

当前仓库仍存在或需要持续防止的版本漂移：

- MCP 文档仍写 7 Tool，实际 24；
- Codex 示例只 allowlist 9 Tool；
- 版本化的旧 L2/L3 文档保留当时的能力限制，脱离版本上下文阅读时容易被误当成当前状态。

建议：从 MCP Registry/CLI help 自动生成接口表；版本文档标注 `as of version`；CI 检查文档 Tool 数和当前注册数。

### 4.15 Host summary 与 Artifact 体积上限

stdout/stderr 各有 20 MiB 捕获上限。审计发现 Host summary 可能接近该上限并在数据库与 `run.json` 重复持久化后，当前实现已增加 12,000 字符 summary 上限、NUL 清理和明确截断标记。`events.jsonl` 仍保留有界原始事件用于审计；原始 task 在非 Windows 路径上没有独立持久化上限，Artifact 总体积也仍需运营监控。

建议：继续为 task 设置跨平台存储上限和原文 hash；为 Artifact 总量、单 Run 数据库增长和清理策略提供可观测性。

### 4.16 历史 Agent 实验与当前 report schema 不同

当前 Eval Runner 会在种入 manifest L1 后先维护派生层，让 Host Prompt 有机会消费 L2/L3；legacy report schema v6 先把 `maintenanceMs/status` 从 `commitMs` 中拆出，当前 Agent report v7 又补齐逐层上下文 telemetry。新的 cross-session summary v3 进一步记录 provided/eligible/injected/deduplicated、raw/cache/total tokens 和每次 attempt。历史 v0.8/RC 报告是 schema v5、L1-only 路径，不能与新结果直接拼接或将旧收益归因于新层。

2026-08-11 已按该原则在全新输出目录完成完整 cross-session 批次，并保留旧报告为历史基线。后续聚合仍必须按 lifecycle/report schema 与实验设计分组；下一轮不能向本批结果目录追加样本。

### 4.17 Host 数据目录并发竞态已修复

审计发现旧 Host helper 会在异步范围临时修改全局 `process.env.REPOMIND_DATA_DIR`，两个并发 Run 可能互相污染。当前实现已将 `dataDirectory` 作为显式依赖传入 `RepositoryMemoryCore -> openRepository -> databasePath`，生命周期 helper 不再跨 `await` 修改进程环境。

双仓库、双 data directory 的并发 Start 回归验证两边 Session 只进入各自数据库，且调用后环境变量保持未设置。CLI 的默认目录仍可从环境变量读取，这是进程启动配置，不再是 Host 请求级传参。

### 4.18 `maxMemories=0` 语义已统一

审计发现公开输入允许 0，而旧实现会强制至少检索一条 L1。当前同步 Start、Hybrid Start 和 Host Run 都在 `maxMemories=0` 时返回零条 L1，同时仍可返回 current L2/L3。Core 与 Host 回归同时验证 Prompt 显示 L1 empty state，L2/L3 不受影响。

这使 L1 消融和最小上下文模式具有可验证语义。评测仍应把“配置值、检索数、最终注入数”同时写入报告，防止未来漂移。

## 5. 效果结论的边界

### 已经能证明

- 在固定 8-task 正式 v0.8 环境中，RepoMind 达到 full-history 的 hidden 正确率；
- 相对 no-memory 同时改善正确率和多项效率指标；
- 在最新 18-run 正式复核中，RepoMind/full-history/no-memory hidden 为 `6/6、6/6、2/6`，全部完整性和预注册门禁通过；
- Host-managed 比 Agent-managed 更适合将生命周期移出模型轮次；
- 同机 OpenCode 与 Claude Code 能延续相同 Project Memory/L4 状态；
- 10k L1 的本地 cached 检索在门槛内；
- 远程提取和恢复的多种非法输入路径零写入。

### 尚不能证明

- 对所有语言、仓库、模型、OS 都普遍提升；
- RepoMind 的能力高于完整历史；
- RepoMind 的成本全面低于完整历史；最新 18-run 中 input token 点估计反而高 `22.1%`，且 full-history 成本差异区间跨 0；
- 最新 18-run 证明 L2/L3 uplift；该轮实际注入 L1/L2/L3=`1/0/0`；
- Remote LLM 自动提取永远语义正确；
- Token 指标可直接跨 Provider 比较或换算成本；
- 10k 本地 deterministic vector 代表远程语义模型表现；
- 2026-08-04 的 `8 tasks × 3 arms × 5 repeats` RC 实验正式通过；该批因 1 次证书故障只可作观察性证据；
- Codex 已完成与 Claude/OpenCode 相同的 acceptance；
- 跨机器团队实时协作已经实现。

## 6. RC.2 之后的工程优先级

当前项目已发布 RC.2，且定位是工程产品而不是科研项目。短期不再把大规模重复实验作为主线：先用 Release 制品在真实仓库持续使用，只有产品决策需要时才增加实验样本。RC 期间只接受安装、兼容性、正确性、数据安全和安全边界方面的发布阻断修复；普通体验改进与新能力进入后续版本。

### P0：安全与一致性

1. Hybrid 原始 query 和持久元数据统一隐私策略；
2. Commit 事务内 CAS，补并发测试；
3. Host 增加 test-required/required-check policy 和更完整的 event Schema；
4. Git porcelain `-z`、结构化 changed files 和采集竞态检测；
5. 评估合法 Project ID 指向已有数据的身份确认策略，并进一步收敛文件系统 TOCTOU；
6. 将 Host Prompt 移出 argv，消除平台命令行长度这一产品约束；
7. 为已修复的 realpath、dangling link、失败命令、并发目录、quote expansion 和结构注入保持跨平台回归。
8. 降低 Windows Vitest worker `onTaskUpdate` 偶发 RPC timeout 对发布门禁的影响；266/266 断言通过仍不应依赖人工判断或盲目重跑。

### P1：产品稳定性与现有分层能力

1. 18-run 已完成 L1-dominant 的 no-memory/full-history/RepoMind 三臂复核；后续仅在产品决策需要时执行 L2/L3 独立消融与紧预算对照，并按层调优预算；
2. 为自动维护提供可观测告警、重试/延迟策略，同时不改变 Commit 成功语义；
3. 修复 L2 stale 截断；
4. L4 保留执行顺序、任务/文件语义并加强审批边界；
5. 在真实用户任务需要时补 Claude -> OpenCode 反向、多任务验证，并为 Codex 设计 Host Adapter；
6. 增加 branch/commit-aware Memory view，减少多 worktree 状态互相影响。

### P2：规模、可操作性和协作

1. 只为 live Memory 同步向量并记录远程成本；
2. 增加数据库维护、诊断和备份调度；
3. 设计 Merge Import 的显式冲突/ID/审计策略；
4. 可选 live DB 加密与 OS key store 集成；
5. 扩展多语言、多公开仓库、多模型、Linux/macOS 的预注册 Agent 实验；
6. 自动生成 CLI/MCP 文档，消除接口漂移。

## 7. 简历和面试中最值得强调的亮点

可以重点讲四条：

1. **Agent 系统架构**：把生命周期从模型循环迁到 Host，真实实验从负面结果迭代到正式通过；
2. **可信记忆模型**：Evidence/Memory 分离、状态机、冲突、stale 和审计，不是简单 RAG；
3. **跨 Agent 与协议解耦**：Core 独立于 MCP SDK，OpenCode/Claude 共享稳定 Project DB；
4. **实验严谨性**：三臂/两臂设计、fresh clone、隐藏检查、顺序轮换、配对指标、Integrity/Acceptance 分离；明确区分 2026-08-04 三臂 120 次的证书故障与 2026-08-11 两臂 120-stage 的正式通过。

最能体现技术深度的不是功能数量，而是能够解释每个设计的代价、验证方法和未解决边界。
