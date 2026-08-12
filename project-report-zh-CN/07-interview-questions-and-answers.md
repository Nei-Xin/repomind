# 07 面试问题与参考答案

## 一、项目定位

### Q1：请用一分钟介绍 RepoMind。

**参考答案：**

RepoMind 是面向 Coding Agent 的本地仓库级持久记忆系统。它通过显式 Session Start/Commit 捕获用户任务、Git baseline/final/diff，以及宿主上报的测试和命令结果；再把原始 Evidence 与可复用的 Atomic Memory 分离。后续 OpenCode、Claude Code 等 Agent 可以依靠同一 Project ID 和 SQLite 检索少量、可追溯的历史知识。

它不只是向量检索，还实现了 FTS5/可选向量 RRF、文件哈希陈旧检测、确定性冲突、validate/correct/invalidate/forget、L0-L4 分层、Host-managed OpenCode 生命周期和三臂真实 Agent 评测。正式 v0.8 的 72 次实验中，RepoMind hidden 24/24，与 full-history 相同，相对 no-memory 同时改善正确率、耗时、Token 和文件读取。

### Q2：项目解决的核心痛点是什么？

**参考答案：**

Coding Agent 每次新会话往往重新探索仓库，尤其无法只从当前代码恢复“为什么这样设计”“哪个方案曾失败”“真正的验证命令是什么”。完整注入对话历史又会造成 Token 大、噪声多、过期结论难治理。

RepoMind 的目标是把跨 Session 的高价值事实压缩为少量 L1，并保留 Evidence 和状态，让 Agent 不必读取完整历史，也能知道结论为什么存在、是否陈旧、是否有冲突。

### Q3：它和普通 RAG 或向量数据库有什么区别？

**参考答案：**

普通 RAG 主要回答“如何切分文档并召回相似片段”。RepoMind 还回答：

- 这条知识来自哪个任务和 Evidence；
- 是否被相关文件变化影响；
- 是否与另一条声明冲突；
- 如何纠错、失效和物理删除；
- 跨 Agent 生命周期如何闭合；
- 高层 Module/Profile/Skill 如何从底层来源派生；
- 是否通过真实 Agent 隐藏检查产生 uplift。

因此 Vector 只是可选检索组件，SQLite 中的生命周期、关系和治理才是主体。

### Q4：为什么不直接保存完整对话？

**参考答案：**

完整对话有三个问题：上下文成本随历史线性增长；包含大量试探、失败和无关内容；不同 Agent 的对话格式不统一。RepoMind 保存少量可独立理解的 L1，Recall 不返回大 Evidence，需要核对时才 Inspect，从而把“任务执行上下文”和“审计上下文”分离。

## 二、架构与跨 Agent

### Q5：为什么 Core 不能依赖 MCP SDK？

**参考答案：**

如果业务规则写在 MCP Tool handler 中，CLI、Host Adapter 和测试会重复实现，容易语义漂移。RepoMind 把 Session、Memory、Search、Governance 都放在 `RepositoryMemoryCore`，MCP 只负责参数验证、调用和错误映射。

这样同一 Core 可被 CLI、MCP、OpenCode Host 和 Eval Runner 驱动，也使跨 Agent 只需要协议适配，不需要重写数据层。

### Q6：RepoMind 如何实现跨 Agent？

**参考答案：**

仓库中的 `.repomind/project.json` 提供稳定 Project ID，真实 SQLite 位于用户数据目录 `~/.repomind/repositories/<projectId>/repomind.db`。同一机器、同一数据目录、相同 marker 的 OpenCode、Claude Code 或其他 MCP Client 打开的是同一项目数据库。

跨 Agent 不是同步对话，而是共享统一的 Session/Evidence/Memory 数据模型。历史 v0.13/v0.15 验收已证明 OpenCode 和 Claude Code 能通过 MCP 共享同一数据库并延续 L4 状态；OpenCode -> Claude repeat 5 进一步证明 Claude 能在 `L1=0` 时消费 OpenCode 产生并由 Host 自动维护的 L2/L3，shared 5/5、isolated 0/5。当前仍未完成 Claude -> OpenCode 反向同类正式验证、多任务外部效度或 Codex 同等 acceptance；跨机器自动同步也尚未实现。

### Q7：为什么 marker 放在仓库、数据库放在用户目录？

**参考答案：**

marker 适合随 Git 复制，让多个 checkout 识别为同一项目；数据库包含 Session、命令、diff 和长期历史，不应默认进入 Git。这个布局同时支持身份稳定和数据隔离。

代价是另一台机器只有 marker，没有 Memory，需要 export/import 或 backup/restore；同一 Project ID 的多 checkout 也共享 project-global 状态。

### Q8：为什么必须显式 Start/Commit？不能自动观察吗？

**参考答案：**

MCP Server 只能看到调用自身 Tool 的消息，无法看到宿主 Agent 的文件、Shell 和测试工具。因此它不可能可靠地被动知道任务开始、修改了什么、测试是否通过或是否完成。

显式 Start 记录 baseline 并召回 Memory；Commit 重新读取 Git，再接收宿主上报的 summary/test/command。这让观察边界清楚。Host-managed 只是由宿主替 Agent 调用协议，不是被动监控。

### Q9：Agent-managed 和 Host-managed 的区别是什么？

**参考答案：**

Agent-managed 中模型直接调用 MCP Start/Search/Commit，能在任务中二次检索，但会消耗模型轮次，并可能忘记闭合 Session。

Host-managed 中 `repomind run` 在模型外 Start，在有界预算下注入 current L3、相关 current L2 和 ranked L1，通过注册 Adapter 运行 OpenCode 或 Claude Code、解析各自 JSONL、Commit/Abandon，并在成功 Commit 后维护派生层。它更稳定，也移除了生命周期模型开销。v0.7 Agent-managed 因耗时回归验收失败，v0.8 Host-managed 正式通过；但那两批实验使用的是当时的 OpenCode L1-only Prompt，不能反向证明新分层注入的收益。

### Q10：Host-managed 当前有哪些实现缺口？

**参考答案：**

当前已注册 OpenCode 与 Claude Code Adapter，分别解析 OpenCode bash/shell 和 Claude Bash/PowerShell 的已知事件；Codex 尚未接入。所有已观测命令现在都必须成功，但没有测试时仍不强制“至少一个 test”。stdout/stderr 捕获上限为 20 MiB，summary 已另限 12,000 字符。Prompt 仍通过 argv 传递，不过当前同时检查 28,000 字符 Prompt 和按 libuv quoting 计算后的 32,767 字符完整 Windows 命令行。长期仍可改用 stdin/文件，并让 manifest 明确 required build/lint/test。

分层注入和 OpenCode -> Claude 单任务消费已经实现，当前更关键的缺口是效果外部效度：需要用 L1-only 与 layered Host 的同批 A/B 验证 L2/L3 没有增加噪声、Token 或 prompt-too-long 回归；还要完成 Claude -> OpenCode 反向、多任务验证，并为 Codex 设计 Host Adapter。

## 三、数据模型与生命周期

### Q11：为什么 Evidence 和 Memory 要分开？

**参考答案：**

Evidence 是任务、Git、测试和命令等原始材料，可能很大；Memory 是后续任务可直接使用的短结论。分开后 Recall 只返回 Memory，控制 Token；Inspect 才展开 Evidence，保留可追溯性。

关系是多对多：一条 Memory 可由多次 Session 支持，一条 Evidence 也可支持多个 Memory。Forget 删除时只清理没有其他引用的 Evidence。

### Q12：Evidence 是否都是客观事实？

**参考答案：**

不是。Git snapshot/diff 是 RepoMind 独立调用 Git 采集；test/command exit code 是宿主上报；summary/decision 是 Agent 声明；validation/correction 是人工判断。Evidence-backed 表示来源可查，不表示所有来源都同等可靠。

因此报告中需要区分“观察证据”和“声明证据”，不能说每条 Memory 都被 Git 数学证明。

### Q13：L0-L4 分别是什么？

**参考答案：**

- L0 是原始 Evidence；
- L1 是单个可复用事实，是 Search/Governance 基本单位；
- L2 是按模块聚合的确定性 Narrative；
- L3 是高置信、稳定的 Repository Profile，保留版本；
- L4 是至少三次成功 Session 中重复工作流的 review-only Skill Candidate。

层级越高，压缩越强、上下文成本越低，但越需要严格来源和陈旧规则。

### Q14：Start 具体做什么？

**参考答案：**

它校验 task、采集 Git baseline，在一个事务中创建 open Session、`user_requirement` 和 baseline `git_snapshot`，然后检索 L1、最多两条 L2 和 current L3。Hybrid Start 再用可选向量结果替换 L1，并返回实际策略和 fallback reason。

若检索阶段失败，已创建 Session 会尽量标为 abandoned，避免 open 泄漏。

### Q15：Commit 具体做什么？

**参考答案：**

先检查 idempotency receipt 和 Session 状态，在事务外重新采集 final Git snapshot/diff；事务内写 summary、final snapshot、可选 diff、tests、commands Evidence，确定性生成 L1，更新 Session 状态并写 receipt。

数据库变更是原子的，但 Git 多次调用不是一个原子快照，这是重要边界。

### Q16：确定性提取会生成哪些 Memory？

**参考答案：**

- 每条 `decisions[]` 生成 decision，confidence 0.85；
- 只有 `tests[].exitCode === 0` 生成 command，confidence 0.95；
- 只有成功 Session 的非空 summary 生成 solution，confidence 0.8。

Decision 直接绑定 summary Evidence；command 绑定对应 test Evidence；solution 绑定 Commit 阶段 Evidence。

### Q17：“Verified command”到底验证了什么？

**参考答案：**

它表示 Commit payload 中该测试命令的 `exitCode` 是 0，Core 据此生成 command Memory。Core 没有独立重跑命令。

Host-managed 中这个值来自 OpenCode event 解析，Agent-managed 中来自 Agent 提交。更准确的名称是“宿主观察并上报成功的命令”，而不是第三方独立验证。

### Q18：Commit 如何实现幂等？

**参考答案：**

`commit_receipts` 以 `(session_id, idempotency_key)` 为主键，完整 payload 经过稳定 JSON hash。同 key 同 payload 返回旧结果；同 key 不同 payload 拒绝；receipt 与 Commit 数据同事务写入。

它支持正常顺序的安全重试，但不是并发 exactly-once。不同 key 的多进程并发 Commit 缺少完整事务内 CAS，应作为后续改进。

### Q19：为什么选择 SQLite？

**参考答案：**

项目是本地单用户工具，数据包含多表关系、状态机、审计、事务和全文检索。SQLite 提供单文件部署、ACID、foreign key、WAL 和 FTS5，足以承担 Source of Truth。

向量只是派生缓存；与其让向量数据库承载所有治理关系，不如让 SQLite 保存真实状态，FTS/vector 都能重建。

### Q20：Session 和 Memory 的状态有什么区别？

**参考答案：**

Session 表示一次任务生命周期：open -> committed/partial/failed/abandoned。Memory 表示知识有效性：active、uncertain、superseded、invalid，或被 forget 物理删除。

任务失败不等于其中所有 Evidence 无价值；远程提取甚至允许从 failed/partial Session 提取 failure/risk 类候选，但必须显式执行。

## 四、检索与治理

### Q21：为什么默认用 FTS5，而不是默认向量？

**参考答案：**

代码仓库大量查询是函数名、路径、命令和错误码，精确词法匹配非常重要。FTS5 本地、零配置、可复现，不会因远程服务失败阻断写入或搜索。

向量只在显式配置后补同义表达召回，失败就降级 FTS。这符合 local-first 和 graceful degradation。

### Q22：词法检索对代码和中文做了什么优化？

**参考答案：**

索引原文之外，还拆分 camelCase、snake_case、kebab-case 和路径；对连续中日韩表意文字生成 overlapping bigram。查询执行相同扩展；CJK 或单 token 结果不足时，再做 substring fallback。

这解决了 SQLite `unicode61` 不会像自然中文分词器那样切分连续文字，以及标识符内部单词无法直接命中的问题。

### Q23：Hybrid Search 如何融合？

**参考答案：**

词法与向量各取最多 20 个候选，用 weighted RRF：

```text
score = 0.65 / (60 + lexicalRank) + 0.35 / (60 + vectorRank)
```

RRF 只依赖排名，不需要把 BM25 和 cosine distance 归一到相同尺度。词法权重更高，符合代码检索特点。

### Q24：向量 Provider 失败会怎样？

**参考答案：**

未配置 Provider、sqlite-vec 加载失败、远程请求失败、维度/数量/finite 校验失败都会返回 FTS 结果和 `fallbackReason`。Memory 写入也不依赖向量。

Embedding 缓存在完整批次验证后统一事务 upsert，因此本次 Provider 失败不会留下半批缓存。

### Q25：Stale Detection 如何工作？

**参考答案：**

Memory 创建时保存 related file 的 hash、size、mtime。Search/Inspect/Review/L2/L3 操作前惰性刷新：metadata 不变且文件修改时间超过两秒时走快速路径；最近两秒内仍重算 hash，防止相同 size/mtime 的快速修改漏检。

发现 created/modified/deleted 后标 uncertain 并带 expected/current hash，不自动判 invalid。文件恢复也需要人工 validate。

### Q26：为什么使用两秒窗口？

**参考答案：**

部分文件系统 mtime 粒度较粗，快速修改可能保持相同 size 和 mtime。只看 metadata 会误判未变化。最近两秒强制 hash 是典型 racy-clean 防护，在性能和正确性之间折中。

### Q27：冲突检测是语义模型吗？

**参考答案：**

不是。它只对声明性类型，在同 repository、type、scope、忽略大小写相同 title、不同 content fingerprint 时判冲突。双方 uncertain，建立 `contradicts` relation。

优点是确定、可测、无模型成本；缺点是不同标题的真实矛盾会漏检，同标题补充也可能误报。

### Q28：为什么 uncertain 仍会被 Search 返回？

**参考答案：**

文件变化或启发式冲突只表示需要复核，不等于结论完全错误。返回并附 warning，Agent 可以对照当前代码使用；直接丢弃可能损失仍有效的历史知识。

superseded/invalid 则已有明确人工或状态信号表明不应继续作为当前结论，因此默认过滤。

### Q29：validate、correct、invalidate、forget 有何不同？

**参考答案：**

- validate：确认原结论仍成立，刷新文件基线，回 active；
- correct：创建 replacement，旧 Memory superseded，并建立 supersedes；
- invalidate：保留正文和 Evidence 供审计，但不再 Recall；
- forget：物理删除正文，并可删除孤立 Evidence，只留无内容 tombstone。

它们分别覆盖“仍正确”“有新答案”“已错误但需留史”“内容必须删除”。

## 五、L2-L4 与远程能力

### Q30：L2 是 LLM 总结吗？

**参考答案：**

不是。L2 从 active、Evidence-backed 且可归属模块的 L1 中，按职责/决策/失败验证/风险固定分组并裁剪。默认 4,000 字符，可用显式 rebuild；成功 Host-managed Commit 也会通过 best-effort 维护调用同一确定性重建逻辑。

优点是可复现和来源清晰；缺点是不推断未记录事实，旧正文覆盖且没有 L3 那样的版本表。

### Q31：L3 如何保证稳定？

**参考答案：**

直接来源必须是 active、repository scope、Evidence-backed、稳定类型且 confidence 默认不低于 0.8。L2 只提供模块边界，L3 重新读取底层 L1 并再次应用门槛。

来源变化后旧 Profile 变 non-current，不再注入；rebuild 创建新版本并保留旧版本正文和 source IDs。低置信 Memory 变化不会使 L3 stale，是有意的稳定性策略。

### Q32：L4 如何发现 Skill？

**参考答案：**

只读取 committed Session，要求至少一个成功 command/test；把规范化、去重、排序后的成功命令集合和测试集合组成 workflow signature，默认至少三个独立 Session 相同才生成 Candidate。失败命令转为 risk。

它是确定性重复模式检测，不是自动训练策略。

### Q33：为什么 L4 不能自动执行？

**参考答案：**

当前签名会丢失真实命令顺序、无法识别语义别名、任务语义不参与分组，可能把不同工作流归在一起。自动执行会把 Memory 系统升级为有副作用的 Automation Runtime，风险明显增加。

因此 Candidate 必须 pending -> approved，才能导出新的 `SKILL.md`；RepoMind 不安装或执行。

### Q34：Remote Extraction 如何防止脏数据？

**参考答案：**

它默认关闭，只在 completed Session 后显式调用。Evidence 每条和总批次有长度上限；模型输出必须通过 strict Zod Schema、confidence <=0.9、Evidence subset、scope/path、数量等完整校验。所有 Candidate 全部合法后才开一个写事务，任一非法候选、超时或取消都零写入。

它只能保证结构和引用合法，不能证明自然语言结论被 Evidence 语义蕴含。

### Q35：L2/L3/L4 会在 Commit 后自动更新吗？

**参考答案：**

要区分调用路径。`commitSession` 本身只写 L0/L1；`repomind commit`、MCP/Agent-managed 和 direct Core Commit 后仍需显式 rebuild。只有成功的 Host-managed Commit 会同步 best-effort 地维护 L2、尝试 L3、刷新 L4。

维护失败单独记录，不回滚已 committed Session；partial、failed、abandoned 不维护；没有 L3 来源记为 skipped。L4 自动阶段只生成/刷新 pending Candidate，不会 approve、export、install 或 execute。

## 六、安全与恢复

### Q36：RepoMind 如何处理仓库中的秘密？

**参考答案：**

写入长期存储前对常见 private key、AWS/GitHub/Slack/OpenAI token、JWT、credential assignment、Bearer token 做模式脱敏；Git diff 直接排除 `.env*`、`.npmrc`、常见 key/cert 文件。

但这是 defense in depth，不是通用 DLP。未知 token 格式、项目自定义 secret 路径会漏检，开启远程 Provider 前仍需审查数据政策。

### Q37：Git 采集真的只读吗？

**参考答案：**

使用 `execFileSync` 和固定参数，不拼 Shell；不会 commit、push、checkout、reset 或 clean，并有 10 秒 timeout、1 MiB上限。准确说法是“不修改 worktree、index 和 refs”。

首次提交场景为取得 empty tree 会调用 `git mktree`，严格说可能写 object database，所以不应绝对宣称任何 Git 内部都零写入。

### Q38：Git Evidence 覆盖哪些变化？

**参考答案：**

覆盖 baseline 到 final HEAD 的 committed diff、tracked working tree diff 和 staged diff；最大 64 KiB，敏感路径排除。Untracked 只在 status 中出现文件名，不采集正文。

Snapshot/diff 是多次 Git 调用，不是原子快照；final clean commit 还可能使自动 related files 为空，这是 stale 覆盖的限制。

### Q39：导出、备份和恢复有什么区别？

**参考答案：**

Logical export/import 用于迁移治理数据，格式 v2，导入是 replace，可映射到另一个已初始化 Project；不包含 FTS/vector/migration bookkeeping。

Physical backup/restore 使用完整 SQLite，必须同一 Project ID；恢复前保留 rollback snapshot。两者都拒绝在 open Session/running Run 时操作，并先支持 dry-run。

### Q40：归档加密保护什么，不保护什么？

**参考答案：**

使用 AES-256-GCM 和 scrypt，保护 export/backup 文件的机密性与完整性，错误密码或篡改在目标写入前失败。Passphrase 只从环境变量读取。

它不加密 live SQLite 或长期 pre-restore snapshot，不提供密钥托管、轮换、云备份，丢失密码无法恢复。

### Q41：安全审计中最需要优先修复的问题是什么？

**参考答案：**

审计最初发现 Project marker 的 `projectId` 只检查非空，随后参与数据库路径拼接。当前已改为 canonical UUID，并对 data root、repositories root、Project directory、DB/WAL/SHM 做 canonical containment 和 link 拒绝；`lstat` 还会捕获 dangling link。

related file 也已增加 `realpath` 后的二次 containment。当前更需要优先处理的是远程 Hybrid Query 使用原始 task 的脱敏不一致、合法 marker 身份指向本机其他 Project 数据、Commit CAS 和文件系统 TOCTOU。

## 七、实验与效果

### Q42：如何证明 RepoMind 提升了 Agent？

**参考答案：**

使用 no-memory、full-history、RepoMind 三臂；每个任务/重复/实验臂 fresh clone 固定 commit，RepoMind data dir 隔离，OpenCode `--pure`，循环轮换 arm 顺序。Agent 完成后用仓库外隐藏 verifier 检查，再按 task+iteration 配对耗时、Token、文件读取等。

同时把 Integrity 和 Acceptance 分开。非零退出、错误 commit、越界修改等使整批无效；隐藏测试失败只是合法能力结果。

### Q43：v0.8 的正式结果是什么？

**参考答案：**

8×3×3 共 72 次，完整性和全部预声明门槛通过。RepoMind hidden 24/24，no-memory 12/24，full-history 24/24。

RepoMind 相对 no-memory：耗时 -39.663%、输入 Token -31.761%、输出 -37.803%、文件读取 -27.273%；相对 full-history 正确率相同，耗时 -12.711%。Host Start+Commit 平均 737 ms，占 1.89%。

### Q44：为什么 v0.7 失败、v0.8 成功？

**参考答案：**

v0.7 让 Agent 主动调用 Start 和 Commit，虽然 hidden 也是 24/24，但相对 full-history 慢 39.713%，超过 15% 门槛。v0.8 把生命周期迁到 Host，移除额外模型轮次。

这证明“Memory 有用”不等于“集成方式高效”。模型循环内的协议成本可能超过检索收益。

### Q45：120 次 RC 实验结果如何？

**参考答案：**

描述性结果是 no-memory 29/40、full-history 39/40、RepoMind 40/40；RepoMind 相对 no-memory 总耗时 -25.167%、输入 Token -16.405%、文件读取 -29.630%。

但一条 full-history 样本发生证书验证错误并非正常退出，因此 Integrity 和 Acceptance 都 failed。排除该故障配对后 full-history/RepoMind 都是 39/39，RepoMind input Token 还高 4.013%。所以只能称“观察到能力信号”，不能称正式验收通过。

### Q46：为什么不能只补跑失败的那一次？

**参考答案：**

实验的顺序轮换、配对和重复数在执行前已经确定。事后只替换基础设施失败样本会引入选择偏差，也破坏完整批次可审计性。

正确做法是预先定义 infrastructure retry policy 后从新目录重跑整批，或将当前批次保留为 failed 并单独报告敏感性分析。

### Q47：预置 Memory 是否相当于泄露答案？

**参考答案：**

在受控八任务实验中，Memory 是 treatment，目的就是隔离“历史知识是否提升 Agent”。它证明的是 Memory availability 的 uplift，不单独证明自动提取质量。

隐藏 verifier 仍在仓库外，Agent 不能读答案；自动提取、跨 Session 和远程提取由其他 acceptance 验证。报告必须明确这两个问题不同。

### Q48：这些结果能推广到所有仓库吗？

**参考答案：**

不能。八个小型 JavaScript fixture 由作者设计，正式实验主要是一个 Runner、少数模型和 Windows 环境。外部 `p-limit` 三个配对提供补充，但仍只有一个仓库。

合理结论是“在固定套件和一个外部仓库观察到收益”；普遍性需要多语言、多公开仓库、多模型、多 OS 的预注册实验。

### Q49：10,000 L1 结果证明了什么？

**参考答案：**

证明本地缓存场景的规模门槛：FTS hit P95 80.363 ms、Hybrid 302.774 ms、Inspect 0.891 ms、Start 621.154 ms。它使用离线 deterministic 64 维向量，不证明远程 Embedding 的延迟、成本或语义质量。

### Q50：Token 指标可信吗？

**参考答案：**

正式 120-stage 结果的 Token 来自 OpenCode event，没有用第二 tokenizer 独立复算。Claude Adapter 也从自身终止事件采集累计 usage，但不同 Runner/Provider 的字段和计价不能直接混合。相同 runner/model/批次内做配对比较有价值；没有价格表时不能换算货币成本。

## 八、批判性与改进题

### Q51：当前最大的产品限制是什么？

**参考答案：**

从用户价值看，OpenCode -> Claude 的单任务 repeat 5 已证明 L2/L3 能在第三个 Session 被实际消费，但双向、多任务与四臂消融仍未完成；从正确性看，是 required-test policy、Commit CAS 与 branch 语义不够完整；从安全看，marker/DB/related-file 路径已硬化，但远程 Hybrid 原始 query、合法 marker 身份指向和 TOCTOU 仍有边界；从实验看，是外部仓库/模型覆盖仍少。

项目现在不是科研优先，下一步应先做 RC 稳定使用和交付反馈；出现 P0/P1 再发布后续 RC。技术债优先级是 Windows Vitest worker 稳定性、隐私、Commit 并发一致性和 Host required-check policy。多任务、反向跨 Agent 与四臂消融只在产品决策确实需要时再做；通用 Adapter 抽象、related-file realpath、失败命令门禁、data-directory 并发、argv quoting、结构标题和零 L1 都已经实现，不应继续冒充未来路线图。

### Q52：如果重新设计 L4，你会怎么做？

**参考答案：**

保留原始 event sequence，而不是只存排序集合；签名加入任务类别、相关文件和关键输出；对常见命令做可解释的语义归一化；检测不同 Session 的偏序一致性；Approval 由 Host policy 限制为人工操作。

仍然先导出 review-only artifact，不直接执行。只有经过 sandbox、权限和回滚设计后，才考虑 Automation。

### Q53：如何减少错误 Memory 对 Agent 的伤害？

**参考答案：**

写入侧：确定性默认、远程 opt-in、confidence cap、Evidence 引用和全批校验。读取侧：status filter、uncertain warning、L3 高置信门槛。维护侧：file stale、conflict、review queue、correct/invalidate/forget。

还可增加 claim-to-evidence 引文、语义 verifier、Memory 使用反馈、按 branch/commit view，以及“无相关 Memory”负对照监控。

### Q54：如何修复 Commit 并发问题？

**参考答案：**

把 Session 状态检查和 `UPDATE sessions ... WHERE status='open'` 放入 `BEGIN IMMEDIATE` 事务，并检查 affected rows；receipt 也在同一临界区处理。必要时增加 version column 做 optimistic concurrency。

然后加入两个进程用同 key、不同 key、相同/不同 payload 并发提交的跨进程测试。

### Q55：如何支持 branch-aware Memory？

**参考答案：**

不能简单把所有 Memory 复制一份。可以给 Evidence 和 Memory provenance 加 branch/head range，并定义 view：全项目稳定事实、branch-local 事实、commit-reachable 事实。

Stale 刷新应针对 checkout view，不直接覆盖 project-global 状态；共享事实只有在所有相关 view 都失效时才全局 uncertain。这个改动会影响 Schema、Search 和治理，需要 Migration 和兼容策略。

### Q56：你会如何演示这个项目？

**参考答案：**

选择真实仓库执行两次相关任务：第一次 Host-managed 生成 committed Session；Inspect solution/command 的 Evidence；第二次展示 retrieved Memory 和更少探索。随后修改 related file，让 Memory 变 uncertain，再人工 validate 或 correct。

最后展示三臂正式报告：不仅演示功能，还证明正确率、Token、耗时和生命周期闭合。整个演示要明确第一次可能没有 Recall、第二次才是跨 Session 价值。

### Q57：请给出一条你不会写进简历的夸大表述。

**参考答案：**

“实现全自动跨平台多 Agent 长期记忆，准确率提升 38%，全面优于完整历史。”

问题是：不是全自动观察；跨平台 CI 不等于所有 Agent Host 都实测；38%取决于具体实验口径；120 次严格失败；排除故障后与 full-history 正确率相同，输入 Token还可能更高。

更准确的表述是：“设计 Evidence-backed 仓库记忆与 Host-managed 生命周期；在 72 次正式三臂实验中与 full-history 同为 24/24 hidden，相对 no-memory 将耗时和输入 Token 分别降低 39.7%和31.8%。”

### Q58：为什么 12,000 字符预算不截断当前任务？

**参考答案：**

预算控制的是 RepoMind 额外注入的 repository context，不是用户需求本身。如果把 task 也放入同一个预算，历史记忆过多时可能截掉验收条件，直接改变任务语义。实现只统计 L3/L2/L1 section body，按 L1:L2:L3=`5:3:2` 分配；task、生命周期说明、标题和信任边界说明在预算外完整保留。代价是总 Prompt 会大于 12,000，所以 repository-context 最高 24,000；Windows 另有 28,000 字符 Prompt guard，以及按 libuv quoting 计算后的 32,767 字符完整命令行 guard。模型上下文窗口仍是外部限制。

### Q59：为什么派生层维护失败不回滚成功 Commit？

**参考答案：**

L0 Evidence、L1 Memory 和 Session 是本次任务的事实写入，L2-L4 是可重建派生视图。若摘要重建失败就回滚已经成功的任务证据，会丢失更重要的 Source of Truth，也把可恢复故障升级成数据丢失。于是 Host 先完成 Commit，再逐层 best-effort 维护并独立记录 status/error；修复原因后可用现有 rebuild 命令重试。这个设计类似主事务与物化视图刷新隔离。

### Q60：为什么“Agent 进程退出码为 0”不能直接等于任务成功？

**参考答案：**

Agent 进程正常退出只说明 Runner 没崩溃，不代表它执行的 build、lint、migration 或 test 都成功。审计曾复现失败 build 被判 success；当前 Host 已改为所有观察到的 bash/shell 命令都必须 `exitCode=0`，否则 Commit 为 partial、跳过派生维护。

正确设计仍应把“进程健康”“已观察命令”“任务验收”分开：下一步由 manifest 声明 required checks，并由外部 public/hidden verifier 独立判断能力结果。当前修复防止已知失败被误判，但不能证明未观察到的测试已经执行。

### Q61：为什么在异步 helper 中临时修改 `REPOMIND_DATA_DIR` 有风险？

**参考答案：**

`process.env` 是进程全局状态，不随 Promise/请求隔离。旧 Host helper 在 await 范围临时切换它时，两个并发 Run 可能读到对方目录。

当前已将 data directory 显式注入 `Core -> openRepository -> databasePath`，Host helper 不再修改全局环境；双目录并发 Start 回归也证明 Session 隔离。这道题的重点是解释为什么依赖注入比 try/finally 恢复全局变量更可靠。

### Q62：Windows Prompt 长度问题最终如何修复？

**参考答案：**

Windows 限制作用于转义后的完整命令行，而不是某个 Prompt 的 `.length`。引号、反斜杠、其他 argv 和可执行路径都会改变实际长度；审计用 17k 引号复现了低于 28k 仍膨胀的问题。

当前保留 28k Prompt guard，同时按 libuv 的 Windows quoting 算法计算 command 和全部 argv，超过 32,767 字符就在 spawn 前拒绝并 abandon Session；引号膨胀用例已回归。长期更彻底的方案仍是 stdin 或临时文件。

### Q63：`maxMemories=0` 为什么是一个值得测试的 API 边界？

**参考答案：**

0 往往表示“明确禁用 L1”，对消融实验和最小上下文模式很重要。审计发现旧实现会把 0 提升为 1，当前同步、Hybrid 和 Host 路径已统一为零条 L1，同时保留 L2/L3。Core 与 Host 测试还断言实际检索、注入统计和 Prompt empty state，防止实验臂被静默污染。

## 九、面试前必须能手画的三张图

1. `Agent/CLI/MCP -> Core -> SQLite/Git/Redaction` 的依赖图；
2. `Start -> Work -> Commit -> Evidence -> L1 -> Recall` 的时序图；
3. `active -> uncertain/superseded/invalid -> forget` 的 Memory 状态机。

如果能在图上补充“哪些证据由 Core 采集、哪些由宿主上报”“Host 的 L3/L2/L1 预算与 task 预算外边界”“Host-only 自动维护、其他入口显式 rebuild”“L4 始终人工审核”，基本能够应对大多数深入追问。
